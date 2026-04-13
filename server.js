const express = require('express');
const cors = require('cors');
const { instagramGetUrl } = require("instagram-url-direct");
const axios = require('axios');
const multer = require('multer');
const Jimp = require('jimp');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the generated tray.png

const runRembgCli = async (inputPath, outputPath) => {
  await new Promise((resolve, reject) => {
    const child = spawn('rembg', ['i', inputPath, outputPath]);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `rembg exited with code ${code}`));
      }
    });
  });
};

const colorDistance = (r1, g1, b1, r2, g2, b2) => {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.hypot(dr, dg, db);
};

const getCornerAverage = (image) => {
  const { width, height } = image.bitmap;
  const sampleSize = Math.max(4, Math.floor(Math.min(width, height) * 0.04));
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  const sampleRect = (startX, startY) => {
    for (let y = startY; y < startY + sampleSize; y += 1) {
      for (let x = startX; x < startX + sampleSize; x += 1) {
        const pixel = Jimp.intToRGBA(image.getPixelColor(x, y));
        totalR += pixel.r;
        totalG += pixel.g;
        totalB += pixel.b;
        count += 1;
      }
    }
  };

  sampleRect(0, 0);
  sampleRect(width - sampleSize, 0);
  sampleRect(0, height - sampleSize);
  sampleRect(width - sampleSize, height - sampleSize);

  return {
    r: Math.round(totalR / Math.max(1, count)),
    g: Math.round(totalG / Math.max(1, count)),
    b: Math.round(totalB / Math.max(1, count)),
  };
};

const enqueueBorderSeeds = (width, height, pushSeed) => {
  for (let x = 0; x < width; x += 1) {
    pushSeed(x, 0);
    pushSeed(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    pushSeed(0, y);
    pushSeed(width - 1, y);
  }
};

const floodFillBackground = (queue, visited, width, height, canRemove) => {
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  const idxOf = (x, y) => y * width + x;

  while (queue.length > 0) {
    const [x, y] = queue.shift();
    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];

    for (const [nx, ny] of neighbors) {
      if (!inBounds(nx, ny)) continue;
      const idx = idxOf(nx, ny);
      if (visited[idx]) continue;
      if (!canRemove(nx, ny)) continue;
      visited[idx] = 1;
      queue.push([nx, ny]);
    }
  }
};

const makeVisitedPixelsTransparent = (image, visited) => {
  const { width, height } = image.bitmap;
  const idxOf = (x, y) => y * width + x;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!visited[idxOf(x, y)]) continue;
      const rgba = Jimp.intToRGBA(image.getPixelColor(x, y));
      image.setPixelColor(Jimp.rgbaToInt(rgba.r, rgba.g, rgba.b, 0), x, y);
    }
  }
};

const removeBackgroundByFloodFill = (image, tolerance = 70) => {
  const { width, height } = image.bitmap;
  const bg = getCornerAverage(image);
  const visited = new Uint8Array(width * height);
  const queue = [];

  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  const idxOf = (x, y) => y * width + x;

  const canRemove = (x, y) => {
    const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(x, y));
    return colorDistance(r, g, b, bg.r, bg.g, bg.b) <= tolerance;
  };

  const pushSeed = (x, y) => {
    if (!inBounds(x, y)) return;
    const idx = idxOf(x, y);
    if (visited[idx]) return;
    if (!canRemove(x, y)) return;
    visited[idx] = 1;
    queue.push([x, y]);
  };

  enqueueBorderSeeds(width, height, pushSeed);
  floodFillBackground(queue, visited, width, height, canRemove);
  makeVisitedPixelsTransparent(image, visited);
};

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

app.post('/api/remove-bg', upload.single('image_file'), async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'image_file is required' });
  }

  const method = String(req.body?.method || 'auto').toLowerCase();
  const rawTolerance = Number(req.body?.tolerance);
  const tolerance = Number.isFinite(rawTolerance)
    ? Math.max(30, Math.min(120, rawTolerance))
    : 70;

  const tempBase = `rembg_${Date.now()}_${Math.round(Math.random() * 1_000_000)}`;
  const inputPath = path.join(os.tmpdir(), `${tempBase}.png`);
  const outputPath = path.join(os.tmpdir(), `${tempBase}_out.png`);

  try {
    if (method === 'auto' || method === 'rembg') {
      try {
        await fsp.writeFile(inputPath, req.file.buffer);
        await runRembgCli(inputPath, outputPath);
        const outBuffer = await fsp.readFile(outputPath);
        res.setHeader('Content-Type', 'image/png');
        return res.status(200).send(outBuffer);
      } catch (rembgError) {
        console.warn('[RemoveBG] rembg failed, using local fallback:', rembgError?.message || rembgError);
        if (method === 'rembg') {
          return res.status(500).json({
            error: 'rembg execution failed',
            details: rembgError?.message || 'Unknown rembg error',
          });
        }
      }
    }

    const image = await Jimp.read(req.file.buffer);
    image.contain(1024, 1024);
    removeBackgroundByFloodFill(image, tolerance);

    const outBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(outBuffer);
  } catch (error) {
    console.error('[RemoveBG] Failed:', error?.message || error);
    return res.status(500).json({ error: 'Failed to remove background' });
  } finally {
    try { await fsp.unlink(inputPath); } catch {}
    try { await fsp.unlink(outputPath); } catch {}
  }
});
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

app.post('/api/convert', async (req, res) => {
  const { url, type, cropPercentage = 0, crop, startTimeSec = 0, durationSec } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const inputPath = path.join(__dirname, `temp_video_${Date.now()}.mp4`);
  const outputExt = type === 'gif' ? 'gif' : 'webp';
  const outputPath = path.join(__dirname, `temp_output_${Date.now()}.${outputExt}`);

  console.log(`[FFmpeg-Cloud] Starting conversion to ${outputExt}`);

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

      const hasCropRect =
        crop &&
        Number.isFinite(Number(crop.x)) &&
        Number.isFinite(Number(crop.y)) &&
        Number.isFinite(Number(crop.width)) &&
        Number.isFinite(Number(crop.height)) &&
        Number.isFinite(Number(crop.editorWidth)) &&
        Number.isFinite(Number(crop.editorHeight)) &&
        Number(crop.width) > 1 &&
        Number(crop.height) > 1 &&
        Number(crop.editorWidth) > 1 &&
        Number(crop.editorHeight) > 1;

      const safeStartSec = Math.max(0, Number(startTimeSec) || 0);
      const defaultDuration = type === 'gif' ? 3 : 2;
      const requestedDuration = Number(durationSec);
      const safeDurationSec = Number.isFinite(requestedDuration)
        ? Math.max(1, Math.min(6, requestedDuration))
        : defaultDuration;

      let cropFilter;
      if (hasCropRect) {
        const editorW = Number(crop.editorWidth);
        const editorH = Number(crop.editorHeight);
        const selectionX = Number(crop.x);
        const selectionY = Number(crop.y);
        const selectionW = Number(crop.width);
        const selectionH = Number(crop.height);

        // Map from editor-space coordinates (ResizeMode.CONTAIN) into source pixels.
        const scale = Math.min(editorW / W, editorH / H);
        const visibleW = W * scale;
        const visibleH = H * scale;
        const visibleOffsetX = (editorW - visibleW) / 2;
        const visibleOffsetY = (editorH - visibleH) / 2;

        const srcX = Math.round((selectionX - visibleOffsetX) / scale);
        const srcY = Math.round((selectionY - visibleOffsetY) / scale);
        const srcW = Math.round(selectionW / scale);
        const srcH = Math.round(selectionH / scale);

        const safeW = Math.max(2, Math.min(W, srcW));
        const safeH = Math.max(2, Math.min(H, srcH));
        const safeX = Math.max(0, Math.min(W - safeW, srcX));
        const safeY = Math.max(0, Math.min(H - safeH, srcY));

        cropFilter = `crop=${safeW}:${safeH}:${safeX}:${safeY}`;
        console.log(`[FFmpeg-Cloud] Using rect crop: ${cropFilter}`);
      } else {
        const cropSize = Math.min(W, H);
        const dynamicY = Math.max(0, (H - cropSize) * cropPercentage);
        cropFilter = `crop=${cropSize}:${cropSize}:0:${dynamicY}`;
        console.log(`[FFmpeg-Cloud] Using fallback crop: ${cropFilter}`);
      }

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
