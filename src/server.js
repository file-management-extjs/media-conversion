const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const mime = require('mime');
const { createVideoAccelerationController, buildScaleFilter } = require('./videoAcceleration');

const app = express();
const PORT = process.env.PORT || 4100;
const WORK_ROOT = path.resolve(process.env.MEDIA_CONVERTER_WORK_ROOT || '/work');
const COMMAND_TIMEOUT_MS = parseInt(process.env.MEDIA_CONVERTER_TIMEOUT_MS || `${15 * 60 * 1000}`, 10);
const MAX_COMMAND_OUTPUT_BYTES = parseInt(process.env.MEDIA_CONVERTER_MAX_OUTPUT_BYTES || `${128 * 1024}`, 10);
const JOB_RETENTION_MS = parseInt(process.env.MEDIA_CONVERTER_JOB_RETENTION_MS || `${60 * 60 * 1000}`, 10);

app.use(express.json({ limit: '1mb' }));

const jobs = new Map();

const audioFormats = {
    mp3: { extension: '.mp3', mimeType: 'audio/mpeg', args: ['-vn', '-c:a', 'libmp3lame'] },
    aac: { extension: '.aac', mimeType: 'audio/aac', args: ['-vn', '-c:a', 'aac'] },
    m4a: { extension: '.m4a', mimeType: 'audio/mp4', args: ['-vn', '-c:a', 'aac'] },
    wav: { extension: '.wav', mimeType: 'audio/wav', args: ['-vn', '-c:a', 'pcm_s16le'] },
    ogg: { extension: '.ogg', mimeType: 'audio/ogg', args: ['-vn', '-c:a', 'libvorbis'] },
    flac: { extension: '.flac', mimeType: 'audio/flac', args: ['-vn', '-c:a', 'flac'] }
};

const videoFormats = {
    mp4: { extension: '.mp4', mimeType: 'video/mp4', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    webm: { extension: '.webm', mimeType: 'video/webm', args: ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] },
    mov: { extension: '.mov', mimeType: 'video/quicktime', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    mkv: { extension: '.mkv', mimeType: 'video/x-matroska', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    avi: { extension: '.avi', mimeType: 'video/x-msvideo', args: ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'] }
};

const imageFormats = {
    png: { extension: '.png', mimeType: 'image/png' },
    jpg: { extension: '.jpg', mimeType: 'image/jpeg' },
    jpeg: { extension: '.jpg', mimeType: 'image/jpeg' },
    webp: { extension: '.webp', mimeType: 'image/webp' },
    avif: { extension: '.avif', mimeType: 'image/avif' }
};

function createHttpError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function sanitizeFilename(filename, fallback = 'converted') {
    const base = path.basename(String(filename || fallback)).trim();
    return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || fallback;
}

function ensureRelativeSafePath(relativePath) {
    const normalized = path.normalize(String(relativePath || '')).replace(/^(\.\.(\/|\\|$))+/, '');

    if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('..')) {
        throw createHttpError('Invalid workspace path.', 400);
    }

    const absolutePath = path.resolve(WORK_ROOT, normalized);
    if (!absolutePath.startsWith(`${WORK_ROOT}${path.sep}`) && absolutePath !== WORK_ROOT) {
        throw createHttpError('Workspace path escaped the conversion root.', 400);
    }

    return {
        relativePath: normalized,
        absolutePath
    };
}

function getRelativePath(absolutePath) {
    return path.relative(WORK_ROOT, absolutePath);
}

function normalizeFormat(format, allowed, fallback = null) {
    const normalized = String(format || fallback || '').toLowerCase().replace(/^\./, '');
    if (!allowed[normalized]) {
        throw createHttpError(`Unsupported target format "${format}".`, 400);
    }

    return normalized;
}

function getOutputPath(outputDir, inputPath, outputFileName, extension, suffix = 'converted') {
    const safeOutputName = sanitizeFilename(outputFileName || '');
    const base = safeOutputName
        ? path.basename(safeOutputName, path.extname(safeOutputName))
        : `${path.basename(inputPath, path.extname(inputPath))}-${suffix}`;

    return path.join(outputDir, `${base}${extension}`);
}

function appendCommandOutput(currentOutput, chunk) {
    const nextOutput = `${currentOutput}${chunk.toString()}`;

    if (nextOutput.length <= MAX_COMMAND_OUTPUT_BYTES) {
        return nextOutput;
    }

    return nextOutput.slice(nextOutput.length - MAX_COMMAND_OUTPUT_BYTES);
}

function registerChildProcess(options, child) {
    if (!options.jobContext) {
        return;
    }

    options.jobContext.processes = options.jobContext.processes || new Set();
    options.jobContext.processes.add(child);
}

function unregisterChildProcess(options, child) {
    if (options.jobContext && options.jobContext.processes) {
        options.jobContext.processes.delete(child);
    }
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        if (options.jobContext && options.jobContext.cancelled) {
            reject(createHttpError('Media conversion cancelled.', 499));
            return;
        }

        const child = spawn(command, args, {
            cwd: options.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        registerChildProcess(options, child);

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            child.kill('SIGKILL');
            reject(createHttpError(`${command} timed out while converting media.`, 504));
        }, options.timeoutMs || COMMAND_TIMEOUT_MS);

        child.stdout.on('data', data => {
            stdout = appendCommandOutput(stdout, data);

            if (typeof options.onStdoutData === 'function') {
                options.onStdoutData(data);
            }
        });

        child.stderr.on('data', data => {
            stderr = appendCommandOutput(stderr, data);
        });

        child.on('error', error => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            unregisterChildProcess(options, child);

            if (error.code === 'ENOENT') {
                reject(createHttpError(`Required media tool "${command}" is not installed.`, 503));
                return;
            }

            reject(error);
        });

        child.on('close', code => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            unregisterChildProcess(options, child);

            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            if (options.jobContext && options.jobContext.cancelled) {
                reject(createHttpError('Media conversion cancelled.', 499));
                return;
            }

            reject(createHttpError((stderr || stdout || '').trim() || `${command} failed with exit code ${code}.`, 422));
        });
    });
}

function runFfmpeg(args, options = {}) {
    const progressArgs = typeof options.onProgress === 'function'
        ? ['-progress', 'pipe:1', '-stats_period', '1']
        : [];
    const progressParser = typeof options.onProgress === 'function'
        ? createFfmpegProgressParser(options.durationSeconds, options.onProgress)
        : null;

    return runCommand('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        ...progressArgs,
        ...args
    ], {
        ...options,
        onStdoutData: progressParser
    });
}

const videoAcceleration = createVideoAccelerationController({
    runCommand,
    logger: console,
    env: process.env
});

async function getMediaDurationSeconds(inputPath) {
    try {
        const result = await runCommand('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            inputPath
        ], { timeoutMs: 30000 });
        const duration = parseFloat(String(result.stdout || '').trim());
        return Number.isFinite(duration) && duration > 0 ? duration : null;
    } catch (error) {
        console.warn('Unable to read media duration for progress:', error.message);
        return null;
    }
}

function parseFfmpegTime(timeValue) {
    const value = String(timeValue || '').trim();
    const parts = value.split(':');

    if (parts.length !== 3) {
        return 0;
    }

    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return (hours * 3600) + (minutes * 60) + seconds;
}

function createFfmpegProgressParser(durationSeconds, onProgress) {
    let buffer = '';
    let latestTimeSeconds = 0;
    let latestProgress = 0;

    return function parseProgressChunk(data) {
        buffer += data.toString();

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        lines.forEach(line => {
            const separatorIndex = line.indexOf('=');
            if (separatorIndex === -1) {
                return;
            }

            const key = line.slice(0, separatorIndex);
            const value = line.slice(separatorIndex + 1);

            if (key === 'out_time_us' || key === 'out_time_ms') {
                latestTimeSeconds = (parseInt(value, 10) || 0) / 1000000;
            } else if (key === 'out_time') {
                latestTimeSeconds = parseFfmpegTime(value);
            } else if (key === 'progress' && value === 'end') {
                latestProgress = 100;
            }

            if (durationSeconds) {
                latestProgress = Math.max(latestProgress, Math.min(99, (latestTimeSeconds / durationSeconds) * 100));
            }

            onProgress(Math.round(latestProgress));
        });
    };
}

function qualityArgs(format, options = {}) {
    const preset = String(options.qualityPreset || 'balanced');
    const videoBitrate = String(options.videoBitrate || '').trim();

    if (format === 'webm') {
        const crfByPreset = {
            low: '40',
            balanced: '34',
            high: '28',
            source: '32'
        };
        const cpuByPreset = {
            low: '6',
            balanced: '5',
            high: '3',
            source: '4'
        };
        const args = [
            '-deadline',
            'good',
            '-cpu-used',
            cpuByPreset[preset] || cpuByPreset.balanced,
            '-row-mt',
            '1',
            '-crf',
            crfByPreset[preset] || crfByPreset.balanced
        ];

        if (!videoBitrate) {
            args.unshift('-b:v', '0');
        }

        return args;
    }

    if (format === 'avi') {
        const qualityByPreset = {
            low: '8',
            balanced: '5',
            high: '3',
            source: '4'
        };

        return videoBitrate ? [] : ['-q:v', qualityByPreset[preset] || qualityByPreset.balanced];
    }

    if (preset === 'low') {
        return ['-crf', '32', '-preset', 'veryfast'];
    }

    if (preset === 'high') {
        return ['-crf', '18', '-preset', 'slow'];
    }

    if (preset === 'source') {
        return ['-crf', '23', '-preset', 'medium'];
    }

    return ['-crf', '24', '-preset', 'medium'];
}

function audioBitrateArgs(options = {}) {
    const bitrate = String(options.audioBitrate || '').trim();
    return bitrate ? ['-b:a', bitrate] : [];
}

function videoBitrateArgs(options = {}) {
    const bitrate = String(options.videoBitrate || '').trim();
    return bitrate ? ['-b:v', bitrate] : [];
}

function resolutionArgs(options = {}) {
    const filter = buildScaleFilter(options);

    if (!filter) {
        return [];
    }

    return ['-vf', filter];
}

async function ensureDirFor(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function outputPayload(filePath, fileName = null, mimeType = null, role = 'output') {
    const name = fileName || path.basename(filePath);

    return {
        path: getRelativePath(filePath),
        fileName: name,
        mimeType: mimeType || mime.getType(name) || 'application/octet-stream',
        role
    };
}

async function convertImage(inputPath, outputDir, outputFileName, options) {
    const format = normalizeFormat(options.targetFormat, imageFormats, 'png');
    const target = imageFormats[format];
    const outputPath = getOutputPath(outputDir, inputPath, outputFileName, target.extension, 'converted');
    const quality = Math.max(1, Math.min(100, parseInt(options.quality || '90', 10)));
    const image = sharp(inputPath, { animated: true });

    await ensureDirFor(outputPath);

    if (format === 'jpg' || format === 'jpeg') {
        await image.jpeg({ quality }).toFile(outputPath);
    } else if (format === 'png') {
        await image.png({ quality }).toFile(outputPath);
    } else if (format === 'webp') {
        await image.webp({ quality }).toFile(outputPath);
    } else if (format === 'avif') {
        await image.avif({ quality }).toFile(outputPath);
    }

    const outputs = [outputPayload(outputPath, path.basename(outputPath), target.mimeType)];

    if (options.generatePreview) {
        outputs.push(await createImagePreview(outputPath, outputDir));
    }

    return outputs;
}

async function createImagePreview(inputPath, outputDir) {
    const outputPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}-preview.jpg`);
    await sharp(inputPath)
        .resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(outputPath);

    return outputPayload(outputPath, path.basename(outputPath), 'image/jpeg', 'preview');
}

async function convertAudio(inputPath, outputDir, outputFileName, options, suffix = 'converted', progressCallback = null, jobContext = null) {
    const format = normalizeFormat(options.targetFormat, audioFormats, 'mp3');
    const target = audioFormats[format];
    const outputPath = getOutputPath(outputDir, inputPath, outputFileName, target.extension, suffix);
    const durationSeconds = progressCallback ? await getMediaDurationSeconds(inputPath) : null;

    await ensureDirFor(outputPath);
    await runFfmpeg([
        '-y',
        '-i',
        inputPath,
        ...target.args,
        ...audioBitrateArgs(options),
        outputPath
    ], {
        durationSeconds,
        onProgress: progressCallback,
        jobContext
    });

    return [outputPayload(outputPath, path.basename(outputPath), target.mimeType)];
}

async function convertVideo(inputPath, outputDir, outputFileName, options, progressCallback = null, jobContext = null) {
    const format = normalizeFormat(options.targetFormat, videoFormats, 'mp4');
    const target = videoFormats[format];
    const outputPath = getOutputPath(outputDir, inputPath, outputFileName, target.extension, 'converted');
    const durationSeconds = progressCallback ? await getMediaDurationSeconds(inputPath) : null;
    const currentVideoBitrateArgs = videoBitrateArgs(options);
    const currentAudioBitrateArgs = audioBitrateArgs(options);
    const cpuArgs = [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        ...target.args,
        ...resolutionArgs(options),
        ...qualityArgs(format, options),
        ...currentVideoBitrateArgs,
        ...currentAudioBitrateArgs,
        outputPath
    ];
    const hardwarePlan = videoAcceleration.buildTranscodePlan({
        inputPath,
        outputPath,
        format,
        options,
        videoBitrateArgs: currentVideoBitrateArgs,
        audioBitrateArgs: currentAudioBitrateArgs
    });

    await ensureDirFor(outputPath);

    if (hardwarePlan) {
        try {
            await runFfmpeg(hardwarePlan.args, {
                durationSeconds,
                onProgress: progressCallback,
                jobContext
            });
        } catch (error) {
            if (error.statusCode === 499 || (jobContext && jobContext.cancelled)) {
                throw error;
            }

            console.warn(`Hardware video conversion failed using ${hardwarePlan.profile.label}. Falling back to CPU: ${error.message}`);
            await runFfmpeg(cpuArgs, {
                durationSeconds,
                onProgress: progressCallback,
                jobContext
            });
        }
    } else {
        await runFfmpeg(cpuArgs, {
            durationSeconds,
            onProgress: progressCallback,
            jobContext
        });
    }

    const outputs = [outputPayload(outputPath, path.basename(outputPath), target.mimeType)];

    if (options.generatePreview) {
        outputs.push(await createVideoThumbnail(outputPath, outputDir, {
            outputFileName: `${path.basename(outputPath, path.extname(outputPath))}-preview.jpg`
        }));
    }

    return outputs;
}

async function videoToGif(inputPath, outputDir, outputFileName, options, progressCallback = null, jobContext = null) {
    const outputPath = getOutputPath(outputDir, inputPath, outputFileName, '.gif', 'animated');
    const duration = Math.max(1, Math.min(60, parseFloat(options.duration || '6')));
    const startTime = String(options.startTime || '0');
    const fps = Math.max(4, Math.min(24, parseInt(options.fps || '12', 10)));
    const width = Math.max(120, Math.min(1280, parseInt(options.width || '640', 10)));
    const qualityPreset = String(options.qualityPreset || 'balanced').trim().toLowerCase();
    const gifQuality = {
        low: {
            maxColors: 96,
            paletteStatsMode: 'diff',
            dither: 'bayer:bayer_scale=4'
        },
        balanced: {
            maxColors: 160,
            paletteStatsMode: 'diff',
            dither: 'sierra2_4a'
        },
        high: {
            maxColors: 256,
            paletteStatsMode: 'full',
            dither: 'sierra2_4a'
        },
        source: {
            maxColors: 256,
            paletteStatsMode: 'single',
            dither: 'sierra2_4a',
            perFramePalette: true
        }
    };
    const quality = gifQuality[qualityPreset] || gifQuality.balanced;
    const baseFilter = `fps=${fps},scale=${width}:-2:flags=lanczos,format=rgba`;
    const palettegen = `palettegen=max_colors=${quality.maxColors}:reserve_transparent=0:stats_mode=${quality.paletteStatsMode}`;
    const paletteuseOptions = [
        `dither=${quality.dither}`,
        quality.perFramePalette ? 'new=1' : null
    ].filter(Boolean).join(':');
    const filterGraph = `${baseFilter},split [gif_frames][palette_source]; [palette_source] ${palettegen} [palette]; [gif_frames][palette] paletteuse=${paletteuseOptions}`;

    await ensureDirFor(outputPath);

    await runFfmpeg([
        '-y',
        '-ss',
        startTime,
        '-t',
        String(duration),
        '-i',
        inputPath,
        '-filter_complex',
        filterGraph,
        '-loop',
        '0',
        outputPath
    ], {
        durationSeconds: duration,
        onProgress: progressCallback,
        jobContext
    });

    return [outputPayload(outputPath, path.basename(outputPath), 'image/gif')];
}

async function createVideoThumbnail(inputPath, outputDir, options = {}, jobContext = null) {
    const outputName = sanitizeFilename(options.outputFileName || `${path.basename(inputPath, path.extname(inputPath))}-thumbnail.jpg`);
    const outputPath = path.join(outputDir, path.extname(outputName).toLowerCase() ? outputName : `${outputName}.jpg`);
    const seekTime = String(options.thumbnailTime || options.startTime || '1');
    const width = parseInt(options.width || '480', 10);
    const vf = Number.isInteger(width) && width > 0 ? ['-vf', `scale=${width}:-2`] : [];

    await ensureDirFor(outputPath);
    await runFfmpeg([
        '-y',
        '-ss',
        seekTime,
        '-i',
        inputPath,
        '-frames:v',
        '1',
        ...vf,
        outputPath
    ], {
        jobContext
    });

    return outputPayload(outputPath, path.basename(outputPath), mime.getType(outputPath) || 'image/jpeg', 'preview');
}

async function handleConvert(payload, progressCallback = null, jobContext = null) {
    const { operation, outputFileName, options = {} } = payload;
    const input = ensureRelativeSafePath(payload.inputPath);
    const output = ensureRelativeSafePath(payload.outputDir);

    await fs.mkdir(output.absolutePath, { recursive: true });

    switch (operation) {
        case 'convertAudio':
            return await convertAudio(input.absolutePath, output.absolutePath, outputFileName, options, 'converted', progressCallback, jobContext);
        case 'convertVideo':
            return await convertVideo(input.absolutePath, output.absolutePath, outputFileName, options, progressCallback, jobContext);
        case 'convertImage':
            if (progressCallback) {
                progressCallback(15);
            }
            return await convertImage(input.absolutePath, output.absolutePath, outputFileName, options);
        case 'extractAudio':
            return await convertAudio(input.absolutePath, output.absolutePath, outputFileName, options, 'audio', progressCallback, jobContext);
        case 'videoToGif':
            return await videoToGif(input.absolutePath, output.absolutePath, outputFileName, options, progressCallback, jobContext);
        case 'thumbnail':
            if (progressCallback) {
                progressCallback(25);
            }
            return await createThumbnail(input.absolutePath, output.absolutePath, outputFileName, options, jobContext);
        default:
            throw createHttpError('Unsupported media conversion operation.', 400);
    }
}

async function createThumbnail(inputPath, outputDir, outputFileName, options, jobContext = null) {
    const inputMimeType = mime.getType(inputPath) || '';

    if (inputMimeType.startsWith('image/')) {
        const requestedName = sanitizeFilename(outputFileName || `${path.basename(inputPath, path.extname(inputPath))}-thumbnail.jpg`);
        const outputName = path.extname(requestedName) ? requestedName : `${requestedName}.jpg`;
        const outputPath = path.join(outputDir, outputName);
        await sharp(inputPath)
            .resize({
                width: Math.max(64, Math.min(1200, parseInt(options.width || '480', 10))),
                height: Math.max(64, Math.min(1200, parseInt(options.height || '320', 10))),
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: Math.max(1, Math.min(100, parseInt(options.quality || '82', 10))) })
            .toFile(outputPath);

        return [outputPayload(outputPath, path.basename(outputPath), 'image/jpeg', 'preview')];
    }

    return [await createVideoThumbnail(inputPath, outputDir, { ...options, outputFileName }, jobContext)];
}

function serializeJob(job) {
    return {
        jobId: job.jobId,
        success: job.status === 'completed',
        status: job.status,
        progress: job.progress,
        error: job.error || null,
        outputs: job.outputs || [],
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
    };
}

function updateJob(job, patch) {
    Object.assign(job, patch, {
        updatedAt: new Date().toISOString()
    });
}

function scheduleJobCleanup(jobId) {
    setTimeout(() => {
        const job = jobs.get(jobId);
        if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) {
            jobs.delete(jobId);
        }
    }, JOB_RETENTION_MS).unref();
}

function startConversionJob(payload) {
    const jobId = crypto.randomUUID();
    const job = {
        jobId,
        status: 'queued',
        progress: 0,
        outputs: [],
        error: null,
        cancelled: false,
        processes: new Set(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    setImmediate(async () => {
        try {
            updateJob(job, {
                status: 'running',
                progress: 1
            });

            const outputs = await handleConvert(payload, progress => {
                if (job.cancelled) {
                    return;
                }

                updateJob(job, {
                    status: 'running',
                    progress: Math.max(1, Math.min(99, Math.round(progress || 0)))
                });
            }, job);

            if (job.cancelled) {
                updateJob(job, {
                    status: 'cancelled',
                    error: 'Media conversion cancelled.'
                });
                return;
            }

            updateJob(job, {
                status: 'completed',
                progress: 100,
                outputs
            });
        } catch (error) {
            updateJob(job, {
                status: job.cancelled ? 'cancelled' : 'failed',
                error: error.message || 'Media conversion failed.'
            });
        } finally {
            scheduleJobCleanup(jobId);
        }
    });

    return job;
}

function cancelConversionJob(job) {
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) {
        return false;
    }

    job.cancelled = true;
    updateJob(job, {
        status: 'cancelled',
        error: 'Media conversion cancelled.'
    });

    if (job.processes) {
        job.processes.forEach(process => {
            try {
                process.kill('SIGTERM');
            } catch (error) {
                console.error('Failed to kill media conversion process:', error);
            }
        });
    }

    scheduleJobCleanup(job.jobId);
    return true;
}

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        service: 'media-converter',
        hardwareAcceleration: videoAcceleration.getStatus()
    });
});

app.post('/convert', async (req, res) => {
    try {
        const outputs = await handleConvert(req.body || {});

        res.status(200).json({
            success: true,
            outputs
        });
    } catch (error) {
        console.error('Media conversion error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Media conversion failed.'
        });
    }
});

app.post('/jobs', (req, res) => {
    try {
        const job = startConversionJob(req.body || {});

        res.status(202).json({
            success: true,
            jobId: job.jobId,
            status: job.status,
            progress: job.progress
        });
    } catch (error) {
        console.error('Media conversion job creation error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to create media conversion job.'
        });
    }
});

app.get('/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
        res.status(404).json({
            success: false,
            error: 'Media conversion job not found.'
        });
        return;
    }

    res.status(200).json(serializeJob(job));
});

app.delete('/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
        res.status(404).json({
            success: false,
            error: 'Media conversion job not found.'
        });
        return;
    }

    const cancelled = cancelConversionJob(job);
    res.status(200).json({
        success: cancelled,
        jobId: job.jobId,
        status: job.status
    });
});

async function bootstrap() {
    try {
        await videoAcceleration.initialize();
    } catch (error) {
        console.warn(`Media converter hardware acceleration probe failed during startup: ${error.message}`);
    }

    app.listen(PORT, () => {
        console.log(`Media converter service listening on port ${PORT}`);
    });
}

bootstrap();
