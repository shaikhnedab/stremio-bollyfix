# BollyFlix Stremio Addon

A Stremio addon that integrates content from [BollyFlix](https://bollyflix.free) - Bollywood movies, Hollywood films, web series, and anime.

## Features

- **Catalog** - Browse latest movies and series from BollyFlix
- **Search** - Search across all BollyFlix content
- **Meta** - Rich metadata including posters, descriptions, cast, ratings
- **Streams** - Direct links to download pages and file host links

## Installation

### Prerequisites
- Node.js >= 18
- npm

### Setup

```bash
git clone <this-repo> bollyflix-stremio-addon
cd bollyflix-stremio-addon
npm install
npm start
```

The addon will start on port 7000 by default.

### Adding to Stremio

1. In Stremio, open the **Add-ons** panel (puzzle piece icon)
2. Click **Install via URL**
3. Enter: `http://localhost:7000/manifest.json`
4. Click **Install**

### Deploying

Set the `PORT` environment variable for your hosting environment:

```bash
PORT=8080 npm start
```

Then use your deployed URL (e.g., `https://your-addon.com/manifest.json`).

## Catalogs

| Catalog ID | Type | Description |
|---|---|---|
| `bollyflix_movies` | movie | Latest movies from BollyFlix |
| `bollyflix_series` | series | Web series, TV shows, anime from BollyFlix |

## Content Types

The addon automatically detects whether content is a **movie** or **series** based on:
- Title keywords ("Season", "WEB Series", "TV Series")
- Categories from BollyFlix

## Stream Sources

The addon extracts download links from BollyFlix pages and attempts to resolve them:
- **Google Drive** links (from `dl.fastdlserver.site`)
- **File host links** (from `linksmod.top` - resolves to mixdrop, gofile, 1fichier, etc.)
- **External URLs** for non-streamable hosts (download-only links)

## How It Works

1. **Catalog requests** are fulfilled via the WordPress REST API (`wp-json/wp/v2/posts`)
2. **Meta requests** parse the HTML content of individual posts for IMDB ratings, cast, genres
3. **Stream requests** extract download links from post HTML and resolve file host links

## Notes

- The BollyFlix domain changes frequently (`.free`, `.to`, etc.). The addon uses `https://bollyflix.free`
- Download links may have timeouts or require visiting the download page
- File host links are resolved on-demand and cached for performance

## License

MIT
