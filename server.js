const express = require('express');
const cors = require('cors');
const { instagramGetUrl } = require("instagram-url-direct");
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the generated tray.png

const decodeInstagramEscapedUrl = (rawUrl) => {
  if (!rawUrl) return '';
  return rawUrl
    .replaceAll(String.raw`\u0026`, '&')
    .replaceAll(String.raw`\/`, '/')
    .replaceAll('&amp;', '&');
};

const normalizeInstagramUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl.trim());
    const path = parsed.pathname.replace(/\/+$/, '');
    const pathMatch = /^\/(reel|p|tv)\/([^/?#]+)/i.exec(path);
    if (pathMatch?.[1] && pathMatch?.[2]) {
      return `https://www.instagram.com/${pathMatch[1].toLowerCase()}/${pathMatch[2]}/`;
    }

    return `${parsed.origin}${path}/`;
  } catch {
    return rawUrl;
  }
};

const extractMediaUrlFromInstagramPage = (html) => {
  if (!html) return null;

  const patterns = [
    /"video_url":"(https:[^"]+)"/,
    /"contentUrl":"(https:[^"]+)"/,
    /"display_url":"(https:[^"]+)"/,
    /"video_versions":\s*\[\s*\{[^}]*"url":"(https:[^"]+)"/,
    /property="og:video"\s+content="(https:[^"]+)"/i,
    /property="og:video:secure_url"\s+content="(https:[^"]+)"/i,
    /property="og:image"\s+content="(https:[^"]+)"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeInstagramEscapedUrl(match[1]);
    }
  }

  return null;
};

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/api/instagram/download', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const normalizedUrl = normalizeInstagramUrl(url);
  console.log(`[Proxy] Fetching Instagram URL: ${normalizedUrl}`);

  try {
    const data = await instagramGetUrl(normalizedUrl);
    if (data?.url_list?.length > 0) {
        const extractedMediaUrl = data.url_list[0];
        console.log(`[Proxy] Successfully extracted media URL: ${extractedMediaUrl}`);
        return res.json({ success: true, url: extractedMediaUrl });
    } else {
        console.log(`[Proxy] Could not extract media URL`, data);
        // Fall through to HTML extraction fallback below.
    }
  } catch (error) {
    console.warn('[Proxy] Primary extractor failed, trying HTML fallback:', error?.message || error);
  }

  try {
    const pageResponse = await axios.get(normalizedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.instagram.com/',
      },
      maxRedirects: 5,
      timeout: 15000,
    });

    const fallbackUrl = extractMediaUrlFromInstagramPage(pageResponse.data);
    if (fallbackUrl) {
      console.log(`[Proxy] Fallback extracted media URL: ${fallbackUrl}`);
      return res.json({ success: true, url: fallbackUrl });
    }

    return res.status(404).json({
      success: false,
      error: 'Could not extract media URL. Ensure the post/reel is public and accessible without login.',
    });
  } catch (fallbackError) {
    console.error('[Proxy] HTML fallback failed:', fallbackError?.message || fallbackError);
    return res.status(500).json({
      success: false,
      error: 'Failed to process URL. Instagram blocked the request from the server region.',
    });
  }
});

const fs = require('node:fs');
const path = require('node:path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

app.post('/api/convert', async (req, res) => {
  const { url, type, cropPercentage = 0, startTimeSec = 0, durationSec } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const inputPath = path.join(__dirname, `temp_video_${Date.now()}.mp4`);
  const outputExt = type === 'gif' ? 'gif' : 'webp';
  const outputPath = path.join(__dirname, `temp_output_${Date.now()}.${outputExt}`);

  console.log(`[FFmpeg-Cloud] Starting conversion to ${outputExt} for requested crop ${cropPercentage}`);

  try {
    // 1. Download the remote media back to the server securely
    const writer = fs.createWriteStream(inputPath);
    const response = await axios({ 
      url, 
      method: 'GET', 
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log(`[FFmpeg-Cloud] Video mapped locally. Executing FFprobe...`);

    // 2. Transcode with Fluent-FFmpeg
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
         console.error('[FFmpeg-Cloud] FFprobe Error:', err);
         if(fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
         return res.status(500).json({ error: 'Could not probe video metadata' });
      }
      
      const stream = metadata.streams.find(s => s.codec_type === 'video');
      const W = stream.width;
      const H = stream.height;
      const cropSize = Math.min(W, H); 
      const safeStartSec = Math.max(0, Number(startTimeSec) || 0);
      const defaultDuration = type === 'gif' ? 3 : 2;
      const requestedDuration = Number(durationSec);
      const safeDurationSec = Number.isFinite(requestedDuration)
        ? Math.max(1, Math.min(6, requestedDuration))
        : defaultDuration;
      
      const dynamicY = Math.max(0, (H - cropSize) * cropPercentage);
      const cropFilter = `crop=${cropSize}:${cropSize}:0:${dynamicY}`;
      const filters = type === 'gif'
        ? [cropFilter, 'fps=15', 'scale=512:512:flags=lanczos']
        : [cropFilter, 'fps=8', 'scale=512:512:flags=lanczos'];
      
      ffmpeg(inputPath)
        .setStartTime(safeStartSec)
        .setDuration(safeDurationSec)
        .videoFilters(filters)
        .outputOptions(
           type === 'gif' 
              ? ['-r 15', '-loop 0']
              : ['-vcodec libwebp', '-lossless 0', '-q:v 28', '-compression_level 6', '-preset picture', '-loop 0', '-an', '-vsync 0']
        )
        .save(outputPath)
        .on('end', async () => {
          console.log(`[FFmpeg-Cloud] Completed ${outputExt} encoding.`);

          if (type === 'webp') {
            const outputSize = fs.statSync(outputPath).size;
            console.log(`[FFmpeg-Cloud] WebP size=${outputSize} bytes`);
            if (outputSize > 500 * 1024) {
              if(fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
              if(fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
              return res.status(422).json({
                error: 'Generated sticker is too large for WhatsApp (>500KB). Try a less busy crop area.',
              });
            }
          }
          
          if (type === 'webp') {
              console.log(`[FFmpeg-Cloud] Raw WebP Generated via FFmpeg successfully.`);
          }

          console.log(`[FFmpeg-Cloud] Sending file back to mobile...`);
          res.sendFile(outputPath, (err) => {
             if(fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
             if(fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
             console.log(`[FFmpeg-Cloud] Cleanup completed.`);
          });
        })
        .on('error', (err) => {
          console.error('[FFmpeg-Cloud] FFmpeg Execution Error:', err);
          if(fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
          res.status(500).json({ error: 'FFmpeg Processing Failed', details: err.message });
        });
    });

  } catch (error) {
    console.error('[FFmpeg-Cloud] Proxy Error:', error.message);
    if(fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    res.status(500).json({ error: 'Failed to download or transcode media' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Node Server is running on port ${PORT}`);
});
