import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://jazzplayer-pc3b06524-minsung-sungs-projects.vercel.app',
  /\.vercel\.app$/
];

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed =>
      allowed instanceof RegExp ? allowed.test(origin) : allowed === origin
    )) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for now
  },
  credentials: true
}));
app.use(express.json());

// Create temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Serve static audio files
app.use('/audio', express.static(TEMP_DIR));

// Clean up old files (older than 1 hour)
function cleanupOldFiles() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;

    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (stats.mtimeMs < oneHourAgo) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}

// Run cleanup every 30 minutes
setInterval(cleanupOldFiles, 30 * 60 * 1000);

// Extract audio from YouTube
app.post('/api/youtube/extract', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate YouTube URL
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
  if (!youtubeRegex.test(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const fileId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${fileId}.mp3`);

  console.log(`Extracting audio from: ${url}`);

  try {
    // First, get video info
    const infoProcess = spawn('yt-dlp', [
      '--dump-json',
      '--no-playlist',
      url
    ]);

    let infoData = '';
    let infoError = '';

    infoProcess.stdout.on('data', (data) => {
      infoData += data.toString();
    });

    infoProcess.stderr.on('data', (data) => {
      infoError += data.toString();
    });

    const videoInfo = await new Promise((resolve, reject) => {
      infoProcess.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(infoData));
          } catch {
            reject(new Error('Failed to parse video info'));
          }
        } else {
          reject(new Error(infoError || 'Failed to get video info'));
        }
      });
    });

    // Now download the audio
    const downloadProcess = spawn('yt-dlp', [
      '-x',                          // Extract audio
      '--audio-format', 'mp3',       // Convert to MP3
      '--audio-quality', '192K',     // Audio quality
      '-o', outputPath,              // Output path
      '--no-playlist',               // Single video only
      '--no-continue',               // Don't continue partial downloads
      url
    ]);

    let downloadError = '';

    downloadProcess.stderr.on('data', (data) => {
      downloadError += data.toString();
      console.log('yt-dlp:', data.toString());
    });

    downloadProcess.stdout.on('data', (data) => {
      console.log('yt-dlp:', data.toString());
    });

    await new Promise((resolve, reject) => {
      downloadProcess.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(downloadError || 'Failed to download audio'));
        }
      });
    });

    // Check if file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('Audio file was not created');
    }

    res.json({
      success: true,
      audioUrl: `/audio/${fileId}.mp3`,
      title: videoInfo.title || 'YouTube Audio',
      duration: videoInfo.duration || 0
    });

  } catch (error) {
    console.error('Extraction error:', error);

    // Clean up partial file if exists
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    res.status(500).json({
      error: error.message || 'Failed to extract audio',
      details: 'Make sure yt-dlp is installed: pip install yt-dlp'
    });
  }
});

// Search lyrics using lrclib.net API
app.get('/api/lyrics/search', async (req, res) => {
  const { title, artist } = req.query;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  console.log(`Searching lyrics for: ${title} ${artist ? `by ${artist}` : ''}`);

  try {
    // Parse title to extract artist and track name
    let searchArtist = artist || '';
    let searchTrack = title;

    // Common patterns in YouTube titles: "Artist - Song Title"
    if (!artist && title.includes(' - ')) {
      const parts = title.split(' - ');
      searchArtist = parts[0].trim();
      searchTrack = parts.slice(1).join(' - ').trim();
    }

    // Remove common YouTube title suffixes
    searchTrack = searchTrack
      .replace(/\(Official.*?\)/gi, '')
      .replace(/\(Music.*?\)/gi, '')
      .replace(/\(Lyric.*?\)/gi, '')
      .replace(/\(Audio.*?\)/gi, '')
      .replace(/\(Video.*?\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?Remaster.*?\)/gi, '')
      .replace(/\(.*?Version.*?\)/gi, '')
      .replace(/\(.*?Mix.*?\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    searchArtist = searchArtist
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .trim();

    console.log(`Parsed: Artist="${searchArtist}", Track="${searchTrack}"`);

    // Try lrclib.net API first (provides synced lyrics)
    const lrclibUrl = new URL('https://lrclib.net/api/search');
    lrclibUrl.searchParams.set('track_name', searchTrack);
    if (searchArtist) {
      lrclibUrl.searchParams.set('artist_name', searchArtist);
    }

    const lrclibResponse = await fetch(lrclibUrl.toString(), {
      headers: {
        'User-Agent': 'JazzPlayer/1.0'
      }
    });

    if (lrclibResponse.ok) {
      const results = await lrclibResponse.json();

      if (results && results.length > 0) {
        // Get the first result with synced lyrics, or plain lyrics as fallback
        const withSynced = results.find(r => r.syncedLyrics);
        const result = withSynced || results[0];

        console.log(`Found lyrics: ${result.trackName} by ${result.artistName}`);

        return res.json({
          success: true,
          source: 'lrclib',
          trackName: result.trackName,
          artistName: result.artistName,
          albumName: result.albumName,
          duration: result.duration,
          plainLyrics: result.plainLyrics || null,
          syncedLyrics: result.syncedLyrics || null
        });
      }
    }

    // If no results, try with just track name
    if (searchArtist) {
      const fallbackUrl = new URL('https://lrclib.net/api/search');
      fallbackUrl.searchParams.set('q', `${searchArtist} ${searchTrack}`);

      const fallbackResponse = await fetch(fallbackUrl.toString(), {
        headers: {
          'User-Agent': 'JazzPlayer/1.0'
        }
      });

      if (fallbackResponse.ok) {
        const results = await fallbackResponse.json();

        if (results && results.length > 0) {
          const withSynced = results.find(r => r.syncedLyrics);
          const result = withSynced || results[0];

          console.log(`Found lyrics (fallback): ${result.trackName} by ${result.artistName}`);

          return res.json({
            success: true,
            source: 'lrclib',
            trackName: result.trackName,
            artistName: result.artistName,
            albumName: result.albumName,
            duration: result.duration,
            plainLyrics: result.plainLyrics || null,
            syncedLyrics: result.syncedLyrics || null
          });
        }
      }
    }

    res.json({
      success: false,
      error: 'Lyrics not found',
      searchedFor: { artist: searchArtist, track: searchTrack }
    });

  } catch (error) {
    console.error('Lyrics search error:', error);
    res.status(500).json({
      error: error.message || 'Failed to search lyrics'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Check if yt-dlp is available
app.get('/api/check-ytdlp', (req, res) => {
  const process = spawn('yt-dlp', ['--version']);

  let version = '';
  process.stdout.on('data', (data) => {
    version += data.toString();
  });

  process.on('close', (code) => {
    if (code === 0) {
      res.json({ available: true, version: version.trim() });
    } else {
      res.json({
        available: false,
        message: 'yt-dlp is not installed. Install with: pip install yt-dlp'
      });
    }
  });

  process.on('error', () => {
    res.json({
      available: false,
      message: 'yt-dlp is not installed. Install with: pip install yt-dlp'
    });
  });
});

app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════╗
  ║     JazzPlayer Backend Server              ║
  ╠════════════════════════════════════════════╣
  ║  Server running on: http://localhost:${PORT}  ║
  ║                                            ║
  ║  Endpoints:                                ║
  ║  POST /api/youtube/extract - Extract audio ║
  ║  GET  /api/lyrics/search   - Search lyrics ║
  ║  GET  /api/health          - Health check  ║
  ╚════════════════════════════════════════════╝

  Make sure yt-dlp is installed:
  pip install yt-dlp
  `);
});
