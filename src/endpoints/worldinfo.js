import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';
import { DEFAULT_USER } from '../constants.js';
import { getUserDirectories } from '../users.js';

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

function getJustinWorldInfoPath(request, worldInfoName = 'justin_lorebook') {
    const filename = sanitize(`${worldInfoName}.json`);
    const explicitPath = process.env.JUSTIN_WORLDINFO_PATH || process.env.LOREBOOK_PATH;
    if (explicitPath) {
        return {
            filename: path.parse(explicitPath).name || filename,
            pathToWorldInfo: explicitPath,
        };
    }

    const directories = request.user?.directories ?? getUserDirectories(DEFAULT_USER.handle);
    return {
        filename,
        pathToWorldInfo: path.join(directories.worlds, filename),
    };
}

function updateJustinEntries(worldInfo, behavioralString, stateSummary) {
    const uid0Replacement = `[CURRENT STATE: Justin is currently in ${stateSummary}]`;
    const uid0Pattern = /\[CURRENT STATE: Justin is currently in [^\]]*\]/;
    let updatedUid0 = false;
    let updatedUid34 = false;

    for (const entry of Object.values(worldInfo.entries ?? {})) {
        if (!entry || typeof entry !== 'object') continue;

        if (entry.uid === 34) {
            entry.content = behavioralString;
            updatedUid34 = true;
            continue;
        }

        if (entry.uid === 0) {
            const currentContent = typeof entry.content === 'string' ? entry.content : '';
            if (uid0Pattern.test(currentContent)) {
                entry.content = currentContent.replace(uid0Pattern, uid0Replacement);
                updatedUid0 = true;
            } else if (currentContent.includes('${state_summary}')) {
                entry.content = currentContent.replace(/\$\{state_summary\}/g, stateSummary);
                updatedUid0 = true;
            } else if (currentContent.length > 0) {
                entry.content = `${currentContent}\n${uid0Replacement}`;
                updatedUid0 = true;
            } else {
                entry.content = uid0Replacement;
                updatedUid0 = true;
            }
        }
    }

    return { updatedUid0, updatedUid34 };
}

export const router = express.Router();

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const file = readWorldInfoFile(request.user.directories, request.body.name, true);

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    fs.unlinkSync(pathToWorldInfo);

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = sanitize(`${request.body.name}.json`);
    const pathToFile = path.join(request.user.directories.worlds, filename);

    writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));

    return response.send({ ok: true });
});

router.post('/sync-justin', (request, response) => {
    try {
        console.log('Justin sync request received');
        const expectedApiKey = String(process.env.SILLYTAVERN_API_KEY ?? '').trim();
        if (expectedApiKey) {
            const suppliedApiKey = String(request.headers['x-api-key'] ?? '').trim();
            if (suppliedApiKey !== expectedApiKey) {
                console.warn('Justin sync rejected: invalid API key');
                return response.status(401).json({ ok: false, error: 'Invalid API key' });
            }
        }

        const smokeMode = /^(1|true|yes)$/i.test(String(process.env.JUSTIN_SYNC_SMOKE ?? '').trim());
        if (smokeMode) {
            console.log('Justin sync smoke mode active');
            return response.status(200).json({
                ok: true,
                smoke: true,
                route: '/api/worldinfo/sync-justin',
            });
        }

        const behavioralString = String(
            request.body?.behavioral_string ?? request.body?.behavioralString ?? ''
        ).trim();
        const stateSummary = String(
            request.body?.state_summary ?? request.body?.stateSummary ?? ''
        ).trim();
        const worldName = String(
            request.body?.world_name ?? request.body?.worldName ?? 'justin_lorebook'
        ).trim();

        if (!behavioralString) {
            return response.status(400).json({ ok: false, error: 'behavioral_string is required' });
        }

        if (!stateSummary) {
            return response.status(400).json({ ok: false, error: 'state_summary is required' });
        }

        const { filename, pathToWorldInfo } = getJustinWorldInfoPath(request, worldName);
        console.log(`Justin sync target resolved: ${pathToWorldInfo}`);

        if (!fs.existsSync(pathToWorldInfo)) {
            console.warn(`Justin sync failed: world info file missing at ${pathToWorldInfo}`);
            return response.status(404).json({ ok: false, error: `World info file ${filename} doesn't exist.` });
        }

        const worldInfo = JSON.parse(fs.readFileSync(pathToWorldInfo, 'utf8'));
        if (!worldInfo || !_.isPlainObject(worldInfo.entries)) {
            console.warn(`Justin sync failed: invalid world info structure at ${pathToWorldInfo}`);
            return response.status(400).json({ ok: false, error: 'World info must contain an entries object' });
        }

        const { updatedUid0, updatedUid34 } = updateJustinEntries(worldInfo, behavioralString, stateSummary);

        if (!updatedUid0 && !updatedUid34) {
            console.warn('Justin sync failed: no matching UID 0 / UID 34 entries found');
            return response.status(404).json({
                ok: false,
                error: 'No matching UID 0 / UID 34 entries found in world info',
            });
        }

        const dryRun = /^(1|true|yes)$/i.test(String(process.env.JUSTIN_SYNC_DRY_RUN ?? '').trim());
        if (dryRun) {
            console.log(
                `Justin sync dry-run active: uid0=${updatedUid0}, uid34=${updatedUid34}, path=${pathToWorldInfo}`,
            );
            return response.json({
                ok: true,
                updated: true,
                dry_run: true,
                world_name: path.parse(filename).name,
                uid0: updatedUid0,
                uid34: updatedUid34,
                state_summary: stateSummary,
            });
        }

        writeFileAtomicSync(pathToWorldInfo, JSON.stringify(worldInfo, null, 2));
        console.log(`Justin sync wrote world info: uid0=${updatedUid0}, uid34=${updatedUid34}`);

        return response.json({
            ok: true,
            updated: true,
            world_name: path.parse(filename).name,
            uid0: updatedUid0,
            uid34: updatedUid34,
            state_summary: stateSummary,
        });
    } catch (error) {
        console.error('Justin sync failed:', error?.stack || error);
        return response.status(500).json({ ok: false, error: 'Justin sync failed' });
    }
});

router.post('/read-justin', (request, response) => {
    try {
        const expectedApiKey = String(process.env.SILLYTAVERN_API_KEY ?? '').trim();
        if (expectedApiKey) {
            const suppliedApiKey = String(request.headers['x-api-key'] ?? '').trim();
            if (suppliedApiKey !== expectedApiKey) {
                console.warn('Justin lorebook read rejected: invalid API key');
                return response.status(401).json({ ok: false, error: 'Invalid API key' });
            }
        }

        const worldName = String(
            request.body?.world_name ?? request.body?.worldName ?? 'justin_lorebook'
        ).trim();
        const { pathToWorldInfo } = getJustinWorldInfoPath(request, worldName);

        if (!fs.existsSync(pathToWorldInfo)) {
            return response.status(404).json({ ok: false, error: `World info file not found: ${worldName}` });
        }

        const worldInfo = JSON.parse(fs.readFileSync(pathToWorldInfo, 'utf8'));
        console.log(`Justin lorebook read: ${Object.keys(worldInfo.entries ?? {}).length} entries served`);
        return response.json({ ok: true, entries: worldInfo.entries ?? {} });
    } catch (error) {
        console.error('Justin lorebook read failed:', error?.stack || error);
        return response.status(500).json({ ok: false, error: 'Failed to read lorebook' });
    }
});
