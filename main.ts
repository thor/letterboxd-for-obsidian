import { App, Plugin, PluginSettingTab, Setting, requestUrl, FuzzySuggestModal, TAbstractFile, TFile, TextComponent, normalizePath, moment } from 'obsidian';
import { XMLParser } from 'fast-xml-parser';
import {
	getDailyNoteSettings
} from "obsidian-daily-notes-interface";


interface LetterboxdSettings {
	username: string;
	dateFormat: string; // Used for daily note links (template)
	displayDateFormat: string; // Used for general date display
	path: string;
	sort: string;
	callout: 'List' | 'ListReview' | 'Callout' | 'CalloutPoster';
	stars: number;
	addReferenceId: boolean;
	linkDate: boolean;
	createMovieNotes: boolean;
	movieNoteTemplate: string;
}

/**
 * Represents one item in the Letterboxd RSS feed
 */
interface RSSEntry {
	title: string
	link: string
	guid: string
	pubDate: string
	'letterboxd:watchedDate': string
	'letterboxd:rewatch': string
	'letterboxd:filmTitle': string
	'letterboxd:filmYear': number
	'letterboxd:memberRating': number
	'tmdb:tvId': number
	description: string
	'dc:creator': string
}

// FileSelect is a subclass of FuzzySuggestModal that is used to select a file from the vault
class FileSelect extends FuzzySuggestModal<TAbstractFile | string> {
	files: TFile[];
	plugin: LetterboxdPlugin;
	values: string[];
	textBox: TextComponent;
	constructor(app: App, plugin: LetterboxdPlugin, textbox: TextComponent) {
		super(app);
		this.files = this.app.vault.getMarkdownFiles();
		this.plugin = plugin;
		// The HTML element for the textbox needs to be passed in to the constructor to update
		this.textBox = textbox;
		this.setPlaceholder('Select or create a file');

		// Logging TAB keypresses to add folder paths to the selection incrementally
		this.scope.register([], 'Tab', e => {
			let child = this.resultContainerEl.querySelector('.suggestion-item.is-selected');
			let text = child ? child.textContent ? child.textContent.split('/') : [] : [];
			let currentInput = this.inputEl.value.split('/');
			let toSlice = text[0] === currentInput[0] ? currentInput.length : 1;
			if (currentInput.length && text[currentInput.length - 1] === currentInput[currentInput.length - 1]) toSlice++;
			this.inputEl.value = text.slice(0, toSlice).join('/');
		});

		// Logging ENTER keypresses to submit the value if there are no selected items
		// ENTER and TAB can only be handelled by different listeners, annoyingly
		this.containerEl.addEventListener('keyup', e => {
			if (e.key !== 'Enter') return;
			if (!this.resultContainerEl.querySelector('.suggestion-item.is-selected') || e.getModifierState('Shift')) {
				this.plugin.settings.path = this.inputEl.value
				this.plugin.saveSettings();
				this.textBox.setValue(this.plugin.settings.path);
				this.close();
			}
		})
	}

	// These functions are built into FuzzySuggestModal
	getItems() {
		return this.files.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.path = item.path;
		this.plugin.saveSettings();
		this.textBox.setValue(this.plugin.settings.path);
	}
}

const DEFAULT_SETTINGS: LetterboxdSettings = {
	username: '',
	dateFormat: getDailyNoteSettings().format ?? '',
	displayDateFormat: 'YYYY-MM-DD',
	path: 'Letterboxd Diary',
	sort: 'Old',
	callout: 'List',
	stars: 0,
	addReferenceId: false,
	linkDate: true,
	createMovieNotes: false,
	movieNoteTemplate: 'Movies/{{title}}',
}

const decodeHtmlEntities = (text: string) => {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/’/g, "'");
};

const objToFrontmatter = (obj: Record<string, any>): string => {
	let yamlString = '---\n';
	for (const key in obj) {
		if (Array.isArray(obj[key])) {
			yamlString += `${key}:\n`;
			obj[key].forEach((value: string) => yamlString += `  - ${value}\n`);
		} else {
			yamlString += `${key}: ${obj[key]}\n`;
		}
	}
	return yamlString += '---\n';
}

function slugify(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.trim();
}

function starParser(rating: number | undefined, star: number): string {
	if (rating === undefined) return '';
	switch (star) {
		case 0:
		default:
			return `(${rating} stars)`;
		case 1:
			return `(${'★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '')})`;
		case 2:
			return `(${'⭐'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '')})`;
	}
}

function getFormattedDate(dateString: string, dateFormat: string): string {
	return dateFormat
		? moment(dateString).format(dateFormat)
		: dateString;
}

function extractReview(descriptionHtml: string): string | null {
	const description = document.createElement('div');
	description.innerHTML = descriptionHtml;
	let reviewText = Array.from(description.querySelectorAll('p'))
		.map(p => p.textContent)
		.filter(text => text && text.trim() !== "")
		.join('\n\n');
	if (reviewText.includes('Watched on')) return null;
	return reviewText;
}

function extractReviewBlockquote(descriptionHtml: string): string {
	const description = document.createElement('div');
	description.innerHTML = descriptionHtml;
	const paragraphs = Array.from(description.querySelectorAll('p'))
		.map(p => p.textContent?.trim())
		.filter(text => text && text !== "" && !text.includes('Watched on'));

	if (paragraphs.length > 0) {
		return paragraphs.map(p => `> ${p}`).join('\n>\n');
	}
	return '';
}

function generateDiaryEntry(settings: LetterboxdSettings, item: RSSEntry, internalLink?: string) {
	let description = document.createElement('div');
	description.innerHTML = item.description;
	const imgElement = description.querySelector('img');
	let img = imgElement ? imgElement.src : null;
	
	// Use extracted review for processing
	let reviewText = extractReview(item.description);
	// Format specifically for the diary entry (replaces original map logic)
	if (reviewText) {
		reviewText = reviewText.split('\n\n').join('\r > \r > ');
	}
	
	const filmTitle = decodeHtmlEntities(item['letterboxd:filmTitle']);

	let stars = starParser(item['letterboxd:memberRating'], settings.stars);
	const reference = (() => {
		if (settings.addReferenceId) {
			return ` ^letterboxd${item.guid.split('-')[2]}`
		}
		return ''
	})();

	const link = internalLink ? internalLink : `[${filmTitle}](${item['link']})`;

	let displayDate: string;
	let watchedPhrase: string;

	if (item['letterboxd:watchedDate']) {
		const formattedDateForLink = getFormattedDate(item['letterboxd:watchedDate'], settings.dateFormat);
		const formattedDateForDisplay = getFormattedDate(item['letterboxd:watchedDate'], settings.displayDateFormat);
		displayDate = settings.linkDate ? `[[${formattedDateForLink}]]` : formattedDateForDisplay;
		watchedPhrase = `Watched ${link} ${stars} on ${displayDate}`;
	} else {
		const formattedDateForDisplay = getFormattedDate(item.pubDate, settings.displayDateFormat);
		displayDate = formattedDateForDisplay; // No linking for pubDate
		watchedPhrase = `Marked as watched ${link} ${stars} on ${displayDate}`;
	}

	switch (settings.callout) {
		case 'List':
			return `- ${watchedPhrase}`;
		case 'ListReview':
			return `- ${watchedPhrase} ${reviewText ? `\r >${reviewText}\n` : ''}`;
		case 'Callout':
			return `> [!letterboxd]+ ${item['letterboxd:memberRating'] !== undefined || reviewText ? 'Review: ' : 'Watched: '} ${link} ${stars} - ${displayDate} \r> ${reviewText ? reviewText : ''}${reference}\n`;
		case 'CalloutPoster':
			return `> [!letterboxd]+ ${item['letterboxd:memberRating'] !== undefined || reviewText ? 'Review: ' : 'Watched: '} ${link} ${stars} - ${displayDate} \r> ${reviewText ? img ? `![${filmTitle}|200](${img}) \r> ${reviewText}` : reviewText : ''}${reference}\n`;
	}
}


export default class LetterboxdPlugin extends Plugin {
	settings: LetterboxdSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'sync',
			name: 'Pull newest entries',
			callback: async () => {
				await this.syncLetterboxd();
			},
		})

		this.addSettingTab(new LetterboxdSettingTab(this.app, this));
	}

	async syncLetterboxd() {
		if (!this.settings.username) {
			throw new Error('Cannot get data for blank username')
		}

		const res = await requestUrl(`https://letterboxd.com/${this.settings.username}/rss/`);
		const parser = new XMLParser();
		let jObj = parser.parse(res.text);
		const items = (jObj.rss.channel.item as RSSEntry[])
			.sort((a, b) => {
				const dateA = new Date(a.pubDate).getTime();
				const dateB = new Date(b.pubDate).getTime();
				return this.settings.sort === 'Old' ? dateA - dateB : dateB - dateA;
			});

		// 1. Process Movie Notes
		const movieNoteLinks = new Map<string, string>(); // guid -> internalLink
		if (this.settings.createMovieNotes) {
			for (const item of items) {
				const link = await this.createOrUpdateMovieNote(item);
				movieNoteLinks.set(item.guid, link);
			}
		}

		// 2. Generate Diary Entries
		const diaryMdArr = items.map((item) => {
			const internalLink = movieNoteLinks.get(item.guid);
			return generateDiaryEntry(this.settings, item, internalLink);
		});

		// 3. Update Diary File
		await this.updateDiaryFile(diaryMdArr);
	}

	async updateDiaryFile(newDiaryEntries: string[]) {
		const filename = normalizePath(this.settings.path.endsWith('.md') ? this.settings.path : this.settings.path + '.md');
		const diaryFile = this.app.vault.getFileByPath(filename)
		
		if (diaryFile === null) {
			let pathArray = this.settings.path.split('/');
			pathArray.pop();
			if (pathArray.length > 1) this.app.vault.createFolder(pathArray.join('/'));
			this.app.vault.create(filename, `${newDiaryEntries.join('\n')}`);
		} else {
			let frontMatter = '';
			this.app.fileManager.processFrontMatter(diaryFile, (data) => {
				if (Object.keys(data).length) frontMatter = objToFrontmatter(data);
			});
			this.app.vault.process(diaryFile, (data) => {
				let diaryContentsArr = data.split('\n');
				// If there is frontmatter, this works out how many lines to ignore.
				if (frontMatter.length) {
					let count = 0;
					while (diaryContentsArr.length > 0) {
						let firstElement = diaryContentsArr.shift();
						if (firstElement === '---') {
							count++;
							if (count === 2) break;
						}
					}
				}
				const diaryContentsSet = new Set(diaryContentsArr);
				const newEntries = newDiaryEntries.filter((entry: string) => !diaryContentsSet.has(entry));
				const finalEntries = this.settings.sort === 'Old'
					? [...diaryContentsArr, ...newEntries]
					: [...newEntries, ...diaryContentsArr];
				return frontMatter.length ? frontMatter + finalEntries.join('\n') : finalEntries.join('\n');
			})
		}
	}

	async createOrUpdateMovieNote(item: RSSEntry): Promise<string> {
		const title = decodeHtmlEntities(item['letterboxd:filmTitle']);
		const year = item['letterboxd:filmYear'].toString();
		const filmYear = item['letterboxd:filmYear'];
		// Sanitize title for filename
		const safeTitle = title.replace(/[:/\\|?*<>\"]/g, '');
		const slug = slugify(title);
		
		let path = this.settings.movieNoteTemplate
			.replace('{{title}}', safeTitle)
			.replace('{{year}}', year)
			.replace('{{slug}}', slug);
		
		if (!path.endsWith('.md')) path += '.md';
		path = normalizePath(path);

		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) {
			const folders = folderPath.split('/');
			let currentPath = '';
			for (const folder of folders) {
				currentPath = currentPath === '' ? folder : currentPath + '/' + folder;
				const existing = this.app.vault.getAbstractFileByPath(currentPath);
				if (!existing) {
					await this.app.vault.createFolder(currentPath).catch(() => {});
				}
			}
		}

		const url = item.link;
		const score = item['letterboxd:memberRating'];
		const isRewatch = item['letterboxd:rewatch'];
		
		let activityDateLink: string;
		let activityDatePrefix: string;

		if (item['letterboxd:watchedDate']) {
			const formattedDateForLink = getFormattedDate(item['letterboxd:watchedDate'], this.settings.dateFormat);
			const formattedDateForDisplay = getFormattedDate(item['letterboxd:watchedDate'], this.settings.displayDateFormat);
			activityDateLink = this.settings.linkDate ? `[[${formattedDateForLink}]]` : formattedDateForDisplay;
			activityDatePrefix = '**Watched:**';
		} else {
			const formattedDateForDisplay = getFormattedDate(item.pubDate, this.settings.displayDateFormat);
			activityDateLink = formattedDateForDisplay; // No link for pubDate
			activityDatePrefix = '**Marked as watched:**';
		}
		
		const reviewBlock = extractReviewBlockquote(item.description);
		const activityLine = `- ${activityDatePrefix} ${activityDateLink} **Rating:** ${score ?? '-'} **Rewatch:** ${isRewatch}`;		const file = this.app.vault.getAbstractFileByPath(path);

		if (file instanceof TFile) {
			// Update
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm['title'] = title;
				fm['source'] = url;
				fm['year'] = filmYear;
				if (score !== undefined) fm['score'] = score;
				delete fm['letterboxd_url'];
			});
			
			await this.rebuildMovieNoteContent(file, reviewBlock, activityLine);

		} else {
			// Create
			const fmObj: any = {
				title: title,
				source: url,
				year: filmYear
			};
			if (score !== undefined) fmObj['score'] = score;

			const frontmatter = objToFrontmatter(fmObj);
			let content = frontmatter;
			
			content += `\n## Letterboxd`;

			if (reviewBlock) {
				content += `\n\n### Review\n\n${reviewBlock}`;
			}
            
            content += `\n\n### Activity\n\n${activityLine}`;

			await this.app.vault.create(path, content);
		}

		return `[[${path.replace('.md', '')}|${title}]]`;
	}

	async rebuildMovieNoteContent(file: TFile, reviewBlock: string, activityLine: string) {
		await this.app.vault.process(file, (content) => {
			const mainHeader = '## Letterboxd';
			const reviewHeader = '### Review';
			const activityHeader = '### Activity';

			const lines = content.split('\n');
			const mainHeaderIdx = lines.findIndex(l => l.trim() === mainHeader);

			if (mainHeaderIdx === -1) {
				// Create new section at the end
				const newSection = [
					'',
					mainHeader,
					...(reviewBlock ? ['', reviewHeader, '', reviewBlock] : []),
					'',
					activityHeader,
					'',
					activityLine
				];
				return content.trimEnd() + '\n' + newSection.join('\n');
			}

			// Find end of Letterboxd section (Next H1 or H2)
			let sectionEndIdx = lines.length;
			for (let i = mainHeaderIdx + 1; i < lines.length; i++) {
				if (lines[i].match(/^#{1,2} /)) { 
					sectionEndIdx = i;
					break;
				}
			}

			const sectionLines = lines.slice(mainHeaderIdx + 1, sectionEndIdx);
			const sectionContent = sectionLines.join('\n');

			// Parse Activities
			const activityHeaderRegex = /### Activity/;
			let activities: string[] = [];
			
			if (activityHeaderRegex.test(sectionContent)) {
				const parts = sectionContent.split(activityHeaderRegex);
				if (parts.length > 1) {
					// Take content until next header (### or ## or #) or end
					// Since we are inside the section, next header could be ### Review (if order flipped) or just new lines
					// Simple split by newline and check
					const rawActivitiesBlock = parts[1];
					// We stop at the next line that starts with #
					const rawLines = rawActivitiesBlock.split('\n');
					for (const line of rawLines) {
						const trimmed = line.trim();
						if (trimmed.startsWith('#')) break; // Next header
						if (trimmed.startsWith('-')) activities.push(trimmed);
					}
				}
			}
			
			// Avoid duplicates
			if (!activities.some(a => a === activityLine.trim())) {
				activities.push(activityLine);
			}

			// Parse Review
			let finalReview = reviewBlock;
			if (!finalReview) {
				// Try to keep existing review if no new one
				const reviewHeaderRegex = /### Review/;
				if (reviewHeaderRegex.test(sectionContent)) {
					const parts = sectionContent.split(reviewHeaderRegex);
					if (parts.length > 1) {
						const rawReviewBlock = parts[1];
						const rawLines = rawReviewBlock.split('\n');
						let extractedLines = [];
						for (const line of rawLines) {
							if (line.trim().startsWith('#')) break; // Next header
							if (line.trim() !== '') extractedLines.push(line);
						}
						finalReview = extractedLines.join('\n').trim();
					}
				}
			}

			// Reconstruct
			const newSectionLines = [mainHeader];
			if (finalReview) {
				newSectionLines.push('');
				newSectionLines.push(reviewHeader);
				newSectionLines.push('');
				newSectionLines.push(finalReview);
			}
			
			newSectionLines.push('');
			newSectionLines.push(activityHeader);
			newSectionLines.push('');
			newSectionLines.push(activities.join('\n'));
			// Add blank line at end of section if needed, or rely on outer join
			newSectionLines.push(''); 
			
			const before = lines.slice(0, mainHeaderIdx);
			const after = lines.slice(sectionEndIdx);
			
			// Ensure clean spacing
			let result = [...before, ...newSectionLines, ...after].join('\n');
			return result.replace(/\n{3,}/g, '\n\n'); // Normalise multiple blank lines
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LetterboxdSettingTab extends PluginSettingTab {
	plugin: LetterboxdPlugin;
	settings: any

	constructor(app: App, plugin: LetterboxdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.settings = this.plugin.loadData()

		containerEl.empty();

		new Setting(containerEl)
			.setName('Letterboxd username')
			.setDesc('The username to fetch data from. This account must be public.')
			.addText((component) => {
				component.setPlaceholder('username')
				component.setValue(this.plugin.settings.username)
				component.onChange(async (value) => {
					this.plugin.settings.username = value
					await this.plugin.saveSettings()
				})
			})


		let fileSelectorText: TextComponent;
		new Setting(containerEl)
			.setName('Set Note')
			.setDesc('Select the file to save your Letterboxd to. If it does not exist, it will be created.')
			.addText((component) => {
				component.setPlaceholder('')
				component.setValue(this.plugin.settings.path)
				component.onChange(async (value) => {
					this.plugin.settings.path = value
					await this.plugin.saveSettings();
				});
				fileSelectorText = component;
			})
			.addButton((component) => {
				component.setButtonText('Select Note');
				component.onClick(async () => {
					new FileSelect(this.app, this.plugin, fileSelectorText).open();
				})
			});

		new Setting(containerEl)
			.setName('Sort by Date')
			.setDesc('Select the order to list your diary entries.')
			.addDropdown((component) => {
				component.addOption('Old', 'Oldest First');
				component.addOption('New', 'Newest First');
				component.setValue(this.plugin.settings.sort)
				component.onChange(async (value) => {
					this.plugin.settings.sort = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName('Display Style')
			.setDesc('Select how to list your reviews. Options cover plain text lists, callouts, or callouts with poster images.')
			.addDropdown((component) => {
				component.addOption('List', 'List Only');
				component.addOption('ListReview', 'List & Reviews');
				component.addOption('Callout', 'Callout');
				component.addOption('CalloutPoster', 'Callout w/ Poster')
				component.setValue(this.plugin.settings.callout.toString());
				component.onChange(async (value: LetterboxdSettings['callout']) => {
					this.plugin.settings.callout = value;
					await this.plugin.saveSettings()
				})
			})
		new Setting(containerEl)
			.setName('Stars')
			.setDesc('Select how you would like stars to be represented.')
			.addDropdown((component) => {
				component.addOption('0', '5 Stars');
				component.addOption('1', '★★★★★');
				component.addOption('2', '⭐⭐⭐⭐⭐')
				component.setValue(this.plugin.settings.stars.toString());
				component.onChange(async (value) => {
					this.plugin.settings.stars = parseInt(value)
					await this.plugin.saveSettings()
				})
			})
		new Setting(containerEl)
			.setName('Add Reference ID')
			.setDesc('Only applies to callouts.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.addReferenceId)
				component.onChange(async (value) => {
					this.plugin.settings.addReferenceId = value
					await this.plugin.saveSettings()
				})
			})
		new Setting(containerEl)
			.setName('Link Dates')
			.setDesc('If enabled, dates will be linked to your daily notes.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.linkDate)
				component.onChange(async (value) => {
					this.plugin.settings.linkDate = value
					await this.plugin.saveSettings()
				})
			})
		
		new Setting(containerEl)
			.setName('Display Date Format')
			.setDesc('The format to use for displaying dates when not linking to daily notes. (e.g., YYYY-MM-DD, MMMM DD, YYYY)')
			.addText((component) => {
				component.setPlaceholder('YYYY-MM-DD')
				component.setValue(this.plugin.settings.displayDateFormat)
				component.onChange(async (value) => {
					this.plugin.settings.displayDateFormat = value
					await this.plugin.saveSettings()
				})
			})
		
		new Setting(containerEl)
			.setName('Create Movie Notes')
			.setDesc('If enabled, individual notes will be created for each movie.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.createMovieNotes)
				component.onChange(async (value) => {
					this.plugin.settings.createMovieNotes = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName('Movie Note Template')
			.setDesc('The file path template for movie notes. Use {{title}}, {{year}}, and {{slug}}.')
			.addText((component) => {
				component.setValue(this.plugin.settings.movieNoteTemplate)
				component.onChange(async (value) => {
					this.plugin.settings.movieNoteTemplate = value
					await this.plugin.saveSettings()
				})
			})
	}
}
