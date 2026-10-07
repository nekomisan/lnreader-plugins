import { Plugin } from '@/types/plugin';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { fetchText } from '@libs/fetch';
import { NovelStatus } from '@libs/novelStatus';
import { load as loadCheerio, type CheerioAPI } from 'cheerio';

class NovelLunarPlugin implements Plugin.PluginBase {
  id = 'novellunar';
  name = 'NovelLunar';
  site = 'https://novellunar.com';
  version = '1.0.0';
  icon = 'src/en/novellunar/icon.png';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://novellunar.com/',
    },
  };

  filters = {
    list: {
      label: 'List',
      value: 'ranking',
      options: [
        { label: 'Ranking', value: 'ranking' },
        { label: 'Latest updates', value: 'latest' },
        { label: 'New novels', value: 'new' },
        { label: 'Completed', value: 'completed' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;

  private normalizePath(href?: string): string | undefined {
    if (!href) return undefined;

    try {
      const url = new URL(href, this.site);

      if (
        url.hostname !== 'novellunar.com' &&
        !url.hostname.endsWith('.novellunar.com')
      ) {
        return undefined;
      }

      const path = url.pathname.replace(/\/+$/, '');
      return path || '/';
    } catch {
      return undefined;
    }
  }

  private normalizeImage(src?: string): string | undefined {
    if (!src) return undefined;

    try {
      return new URL(src, this.site).toString();
    } catch {
      return undefined;
    }
  }

  private titleFromSlug(path: string): string {
    const slug = path.split('/').filter(Boolean).pop() || 'Untitled';

    return slug
      .replace(/-v\d+(?:_[a-z0-9]+)?$/i, '')
      .replace(/_[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  private getCardTitle(
    $: CheerioAPI,
    element: any,
    path: string,
  ): string {
    const anchor = $(element);

    const alt = anchor.find('img[alt]').first().attr('alt')?.trim();
    if (alt && alt.length > 1) return alt;

    const heading = anchor
      .find(
        'h1,h2,h3,h4,h5,[class*="font-semibold"],[class*="font-medium"],[class*="font-bold"]',
      )
      .toArray()
      .map(node => $(node).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter(text => !/^(ongoing|completed)$/i.test(text))
      .filter(text => !/^\d[\d,.]*\s*(chapters?|ch|views?)/i.test(text))
      .sort((a, b) => b.length - a.length)[0];

    if (heading) return heading;

    const rawText = anchor.text().replace(/\s+/g, ' ').trim();
    const cleaned = rawText
      .replace(/^(ongoing|completed)\s+/i, '')
      .replace(/\s+\d[\d,.]*\s*chapters?.*$/i, '')
      .trim();

    return cleaned || this.titleFromSlug(path);
  }

  private parseNovelList(html: string): Plugin.NovelItem[] {
    if (!html) return [];

    const $ = loadCheerio(html);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const path = this.normalizePath(anchor.attr('href'));

      if (!path || !/^\/novel\/[^/]+$/i.test(path) || seen.has(path)) {
        return;
      }

      seen.add(path);

      const image = anchor.find('img').first();
      const srcset = image.attr('srcset');

      const cover =
        image.attr('src') ||
        image.attr('data-src') ||
        srcset?.split(',')[0]?.trim().split(/\s+/)[0];

      novels.push({
        name: this.getCardTitle($, element, path),
        path,
        cover: this.normalizeImage(cover) || defaultCover,
      });
    });

    return novels;
  }

  private parseStatus($: CheerioAPI): string {
    let status = '';

    $('span,div,p').each((_, element) => {
      if (status) return;

      const text = $(element).text().replace(/\s+/g, ' ').trim();

      if (/^(ongoing|completed)$/i.test(text)) {
        status = text.toLowerCase();
      }
    });

    if (status === 'completed') return NovelStatus.Completed;
    if (status === 'ongoing') return NovelStatus.Ongoing;

    return NovelStatus.Unknown;
  }

  private parseChapterCount($: CheerioAPI): number {
    const exact = $(
      'div.gap-1\\.5:nth-child(2) > span:nth-child(2)',
    )
      .first()
      .text()
      .trim();

    const exactMatch = exact.match(/(\d[\d,]*)/);

    if (exactMatch) {
      const count = Number(exactMatch[1].replace(/,/g, ''));

      if (Number.isInteger(count) && count > 0) {
        return count;
      }
    }

    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const fallback = bodyText.match(/(\d[\d,]*)\s+chapters\b/i);

    if (!fallback) return 0;

    const count = Number(fallback[1].replace(/,/g, ''));
    return Number.isInteger(count) && count > 0 ? count : 0;
  }

  private parseGenres($: CheerioAPI): string | undefined {
    const genres: string[] = [];

    $('.inline-block').each((_, element) => {
      const text = $(element).text().replace(/\s+/g, ' ').trim();

      if (
        !text ||
        /^(ongoing|completed)$/i.test(text) ||
        genres.some(genre => genre.toLowerCase() === text.toLowerCase())
      ) {
        return;
      }

      genres.push(text);
    });

    return genres.length ? genres.join(', ') : undefined;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const section = showLatestNovels ? 'latest' : filters.list.value;
    const page = Math.max(pageNo, 1);

    const html = await fetchText(`${this.site}/${section}?page=${page}`, {
      headers: {
        Referer: `${this.site}/`,
      },
    });

    return this.parseNovelList(html);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path =
      this.normalizePath(novelPath) ||
      `/${novelPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;

    const html = await fetchText(`${this.site}${path}`, {
      headers: {
        Referer: `${this.site}/`,
      },
    });

    if (!html) {
      return {
        path,
        name: this.titleFromSlug(path),
        cover: defaultCover,
        status: NovelStatus.Unknown,
        chapters: [],
      };
    }

    const $ = loadCheerio(html);

    const name =
      $('.text-2xl').first().text().trim() ||
      this.titleFromSlug(path);

    const author = $('a.text-blue-500')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    const coverSrc =
      $("div[class*='aspect-[3/4]'] > img").first().attr('src') ||
      $('img[alt]').first().attr('src');

    const summary =
      $('p.text-gray-600').first().text().replace(/\s+/g, ' ').trim() ||
      undefined;

    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const ratingMatch = bodyText.match(
      /\b([0-5](?:\.\d+)?)\s*\(\s*\d[\d,]*\s+reviews?\s*\)/i,
    );
    const rating = ratingMatch ? Number(ratingMatch[1]) : undefined;

    const chapterCount = this.parseChapterCount($);
    const chapters: Plugin.ChapterItem[] = [];

    for (let chapterNumber = 1; chapterNumber <= chapterCount; chapterNumber++) {
      chapters.push({
        name: `Chapter ${chapterNumber}`,
        path: `${path}/chapter/${chapterNumber}`,
        chapterNumber,
      });
    }

    return {
      path,
      name,
      author: author || undefined,
      cover: this.normalizeImage(coverSrc) || defaultCover,
      genres: this.parseGenres($),
      summary,
      status: this.parseStatus($),
      rating,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path =
      this.normalizePath(chapterPath) ||
      `/${chapterPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;

    const html = await fetchText(`${this.site}${path}`, {
      headers: {
        Referer: `${this.site}/`,
      },
    });

    if (!html) return '';

    const $ = loadCheerio(html);
    const content = $('div.text-gray-800').first();

    if (!content.length) return '';

    content.find('script,style,button,nav').remove();

    content.find('span').each((_, element) => {
      const span = $(element);

      if (!span.text().trim()) {
        span.replaceWith('<br>');
      }
    });

    return content.html()?.trim() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();
    if (!term) return [];

    const page = Math.max(pageNo, 1);
    const encoded = encodeURIComponent(term);
    const normalizedTerm = term.toLowerCase();

    const possibleSearchUrls = [
      `${this.site}/search?q=${encoded}&page=${page}`,
      `${this.site}/search?keyword=${encoded}&page=${page}`,
      `${this.site}/search?query=${encoded}&page=${page}`,
    ];

    for (const url of possibleSearchUrls) {
      const html = await fetchText(url, {
        headers: {
          Referer: `${this.site}/`,
        },
      });

      const matches = this.parseNovelList(html).filter(novel =>
        novel.name.toLowerCase().includes(normalizedTerm),
      );

      if (matches.length) return matches;
    }

    if (pageNo > 1) return [];

    const slug = term
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    for (const candidate of [slug, `${slug}-v1`]) {
      if (!candidate) continue;

      const path = `/novel/${candidate}`;
      const html = await fetchText(`${this.site}${path}`, {
        headers: {
          Referer: `${this.site}/`,
        },
      });

      if (!html) continue;

      const $ = loadCheerio(html);
      const title = $('.text-2xl').first().text().trim();

      if (title && title.toLowerCase().includes(normalizedTerm)) {
        const coverSrc =
          $("div[class*='aspect-[3/4]'] > img").first().attr('src') ||
          $('img[alt]').first().attr('src');

        return [
          {
            name: title,
            path,
            cover: this.normalizeImage(coverSrc) || defaultCover,
          },
        ];
      }
    }

    const results = new Map<string, Plugin.NovelItem>();

    for (const section of ['ranking', 'latest', 'new']) {
      const html = await fetchText(`${this.site}/${section}?page=1`, {
        headers: {
          Referer: `${this.site}/`,
        },
      });

      for (const novel of this.parseNovelList(html)) {
        if (novel.name.toLowerCase().includes(normalizedTerm)) {
          results.set(novel.path, novel);
        }
      }
    }

    return [...results.values()];
  }

  resolveUrl = (path: string) => {
    const normalized = this.normalizePath(path);

    return normalized
      ? `${this.site}${normalized}`
      : `${this.site}/${path.replace(/^\/+/, '')}`;
  };
}

export default new NovelLunarPlugin();
