const DEFAULT_MODE = 'auto';
const DEFAULT_PROFILE_ORDER = ['qsv', 'vaapi'];
const DEFAULT_VAAPI_DEVICES = ['/dev/dri/renderD128', '/dev/dri/card0'];
const HARDWARE_READY_FORMATS = new Set(['mp4', 'mov', 'mkv']);

function parseCsv(value, fallback = []) {
    const items = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return items.length ? items : fallback.slice();
}

function normalizeMode(value) {
    const mode = String(value || DEFAULT_MODE).trim().toLowerCase();
    return ['auto', 'cpu', 'gpu'].includes(mode) ? mode : DEFAULT_MODE;
}

function buildScaleFilter(options = {}) {
    const resolution = String(options.resolution || 'source').trim().toLowerCase();

    if (resolution === 'source') {
        return null;
    }

    const presetHeights = {
        '2160p': 2160,
        '1440p': 1440,
        '1080p': 1080,
        '720p': 720,
        '480p': 480,
        '360p': 360
    };
    const customHeight = parseInt(options.height, 10);
    const height = presetHeights[resolution] || customHeight;

    if (!Number.isInteger(height) || height <= 0) {
        return null;
    }

    return `scale=-2:${height}`;
}

function buildHardwareQualityArgs(profileName, options = {}) {
    const preset = String(options.qualityPreset || 'balanced').trim().toLowerCase();
    const hasExplicitBitrate = Boolean(String(options.videoBitrate || '').trim());

    if (hasExplicitBitrate) {
        return [];
    }

    const qualityByPreset = {
        low: '32',
        balanced: '26',
        high: '20',
        source: '23'
    };
    const selectedQuality = qualityByPreset[preset] || qualityByPreset.balanced;

    if (profileName === 'qsv') {
        return ['-global_quality', selectedQuality];
    }

    if (profileName === 'vaapi') {
        return ['-qp', selectedQuality];
    }

    return [];
}

function buildHardwareFilter(profileName, options = {}) {
    const filters = [];
    const scaleFilter = buildScaleFilter(options);

    if (scaleFilter) {
        filters.push(scaleFilter);
    }

    filters.push('format=nv12');

    if (profileName === 'qsv') {
        filters.push('hwupload=extra_hw_frames=64');
    } else if (profileName === 'vaapi') {
        filters.push('hwupload');
    }

    return filters.join(',');
}

function buildQsvProbeArgs() {
    return [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=128x128:rate=1',
        '-frames:v',
        '1',
        '-vf',
        'format=nv12,hwupload=extra_hw_frames=64',
        '-c:v',
        'h264_qsv',
        '-f',
        'null',
        '-'
    ];
}

function buildVaapiProbeArgs(devicePath) {
    return [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-vaapi_device',
        devicePath,
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=128x128:rate=1',
        '-frames:v',
        '1',
        '-vf',
        'format=nv12,hwupload',
        '-c:v',
        'h264_vaapi',
        '-f',
        'null',
        '-'
    ];
}

function serializeProfile(profile) {
    if (!profile) {
        return null;
    }

    return {
        name: profile.name,
        label: profile.label,
        device: profile.device || null
    };
}

function createVideoAccelerationController({ runCommand, logger = console, env = process.env }) {
    const state = {
        mode: normalizeMode(env.MEDIA_CONVERTER_HWACCEL_MODE),
        profileOrder: parseCsv(env.MEDIA_CONVERTER_HWACCEL_PROFILES, DEFAULT_PROFILE_ORDER),
        vaapiDevices: parseCsv(env.MEDIA_CONVERTER_VAAPI_DEVICES, DEFAULT_VAAPI_DEVICES),
        initialized: false,
        activeProfile: null,
        availableProfiles: [],
        probeErrors: [],
        disabledReason: null,
        lastProbeAt: null
    };

    async function probeQsv() {
        await runCommand('ffmpeg', buildQsvProbeArgs(), { timeoutMs: 30000 });

        return {
            name: 'qsv',
            label: 'Intel Quick Sync'
        };
    }

    async function probeVaapi() {
        const attemptedDevices = state.vaapiDevices.length ? state.vaapiDevices : DEFAULT_VAAPI_DEVICES;

        for (const devicePath of attemptedDevices) {
            try {
                await runCommand('ffmpeg', buildVaapiProbeArgs(devicePath), { timeoutMs: 30000 });

                return {
                    name: 'vaapi',
                    label: 'VAAPI',
                    device: devicePath
                };
            } catch (error) {
                state.probeErrors.push({
                    profile: 'vaapi',
                    device: devicePath,
                    message: error.message
                });
            }
        }

        return null;
    }

    async function probeProfile(profileName) {
        if (profileName === 'qsv') {
            return await probeQsv();
        }

        if (profileName === 'vaapi') {
            return await probeVaapi();
        }

        return null;
    }

    async function initialize() {
        if (state.initialized) {
            return getStatus();
        }

        state.initialized = true;
        state.lastProbeAt = new Date().toISOString();
        state.availableProfiles = [];
        state.probeErrors = [];
        state.activeProfile = null;
        state.disabledReason = null;

        if (state.mode === 'cpu') {
            state.disabledReason = 'Hardware acceleration is disabled by configuration.';
            return getStatus();
        }

        for (const profileName of state.profileOrder) {
            try {
                const profile = await probeProfile(profileName);

                if (profile) {
                    state.availableProfiles.push(profile);
                }
            } catch (error) {
                state.probeErrors.push({
                    profile: profileName,
                    message: error.message
                });
            }
        }

        if (state.availableProfiles.length) {
            state.activeProfile = state.availableProfiles[0];
            logger.log(`Media converter will use ${state.activeProfile.label} acceleration when possible.`);
            return getStatus();
        }

        state.disabledReason = state.mode === 'gpu'
            ? 'Hardware acceleration was requested, but no compatible FFmpeg device was detected.'
            : 'No compatible FFmpeg hardware acceleration device was detected.';

        logger.log(`Media converter falling back to CPU: ${state.disabledReason}`);
        return getStatus();
    }

    function getStatus() {
        return {
            mode: state.mode,
            activeProfile: serializeProfile(state.activeProfile),
            availableProfiles: state.availableProfiles.map(serializeProfile),
            disabledReason: state.disabledReason,
            initialized: state.initialized,
            lastProbeAt: state.lastProbeAt,
            probeErrors: state.probeErrors.slice()
        };
    }

    function supportsFormat(format) {
        return HARDWARE_READY_FORMATS.has(String(format || '').trim().toLowerCase());
    }

    function buildTranscodePlan({ inputPath, outputPath, format, options = {}, videoBitrateArgs = [], audioBitrateArgs = [] }) {
        if (!state.activeProfile || !supportsFormat(format)) {
            return null;
        }

        const profileName = state.activeProfile.name;
        const args = ['-y'];

        if (profileName === 'vaapi' && state.activeProfile.device) {
            args.push('-vaapi_device', state.activeProfile.device);
        }

        args.push(
            '-i',
            inputPath,
            '-map',
            '0:v:0',
            '-map',
            '0:a?'
        );

        const filterChain = buildHardwareFilter(profileName, options);
        if (filterChain) {
            args.push('-vf', filterChain);
        }

        args.push(
            '-c:v',
            profileName === 'qsv' ? 'h264_qsv' : 'h264_vaapi',
            ...buildHardwareQualityArgs(profileName, options),
            ...videoBitrateArgs,
            '-c:a',
            'aac',
            ...audioBitrateArgs,
            outputPath
        );

        return {
            profile: serializeProfile(state.activeProfile),
            args
        };
    }

    return {
        initialize,
        getStatus,
        buildScaleFilter,
        buildTranscodePlan
    };
}

module.exports = {
    createVideoAccelerationController,
    buildScaleFilter
};
