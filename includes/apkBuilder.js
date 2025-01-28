const cp = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const CONST = require('./const');

/**
 * Memeriksa dan membuat direktori jika tidak ada
 * @param {string} dir Path direktori
 */
async function ensureDirectoryExists(dir) {
    try {
        await fsp.access(dir);
    } catch {
        await fsp.mkdir(dir, { recursive: true });
    }
}

/**
 * Memeriksa versi Java yang terinstall
 * @returns {Promise<string>} Versi Java yang terdeteksi
 */
async function checkJavaVersion() {
    return new Promise((resolve, reject) => {
        const spawn = cp.spawn('java', ['-version']);
        let output = '';

        spawn.on('error', (err) => {
            reject(new Error(`Java tidak terinstall: ${err.message}`));
        });

        spawn.stderr.on('data', (data) => {
            output += data.toString();
        });

        spawn.on('close', (code) => {
            const javaIndex = output.indexOf('java version');
            const openJDKIndex = output.indexOf('openjdk version');
            
            const javaVersion = javaIndex !== -1 ? output.substring(javaIndex, javaIndex + 27) : '';
            const openJDKVersion = openJDKIndex !== -1 ? output.substring(openJDKIndex, openJDKIndex + 27) : '';
            
            const version = javaVersion || openJDKVersion;

            if (!version) {
                reject(new Error('Java tidak terdeteksi di sistem'));
                return;
            }

            // Mendukung berbagai versi Java yang kompatibel
            const supportedVersions = ['1.8.0', '11.0', '16.0.2', '17.0'];
            const isSupported = supportedVersions.some(v => version.includes(v));

            if (!isSupported) {
                reject(new Error(`Versi Java tidak didukung. Terdeteksi: ${version}. Harap gunakan Java versi: ${supportedVersions.join(', ')}`));
                return;
            }

            resolve(version);
        });
    });
}

/**
 * Memodifikasi APK dengan URI dan PORT baru
 * @param {string} URI - URI untuk patch
 * @param {number} PORT - Port number
 * @returns {Promise<void>}
 */
async function patchAPK(URI, PORT) {
    try {
        // Validasi input
        if (!URI || typeof URI !== 'string') {
            throw new Error('URI tidak valid');
        }

        if (!PORT || typeof PORT !== 'number' || PORT >= 25565 || PORT <= 0) {
            throw new Error('Port harus antara 1-25564');
        }

        // Memastikan direktori ada
        await ensureDirectoryExists(path.dirname(CONST.patchFilePath));

        // Memastikan file patch ada
        try {
            await fsp.access(CONST.patchFilePath);
        } catch {
            throw new Error('File patch tidak ditemukan');
        }

        const data = await fsp.readFile(CONST.patchFilePath, 'utf8');
        
        // Mencari dan mengganti URL
        const urlRegex = /https?:\/\/[^\s?]+/;
        const match = data.match(urlRegex);
        
        if (!match) {
            throw new Error('URL pattern tidak ditemukan di file patch');
        }

        const newUrl = `http://${URI}:${PORT}`;
        const result = data.replace(match[0], newUrl);

        await fsp.writeFile(CONST.patchFilePath, result, 'utf8');
        
        console.log(`APK berhasil di-patch dengan URL: ${newUrl}`);
        
    } catch (error) {
        throw new Error(`Gagal melakukan patch APK: ${error.message}`);
    }
}

/**
 * Memeriksa keberadaan file
 * @param {string} filePath Path file yang akan dicek
 */
async function checkFileExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Menjalankan command shell dan menunggu hasilnya
 * @param {string} command Command yang akan dijalankan
 * @returns {Promise<void>}
 */
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Execution error:', error);
                console.error('stderr:', stderr);
                reject(error);
                return;
            }
            console.log('stdout:', stdout);
            resolve(stdout);
        });
    });
}

/**
 * Membangun APK dari source
 * @returns {Promise<string>} Path ke APK yang sudah di-build
 */
async function buildAPK() {
    try {
        // 1. Persiapan direktori
        console.log('Mempersiapkan direktori...');
        await fsp.mkdir(CONST.outputPath, { recursive: true });
        
        // 2. Verifikasi keberadaan tools
        console.log('Memeriksa tools yang diperlukan...');
        const requiredFiles = [CONST.apkTool, CONST.apkSign];
        for (const file of requiredFiles) {
            if (!await checkFileExists(file)) {
                throw new Error(`File tidak ditemukan: ${file}`);
            }
        }

        // 3. Build APK dengan output yang lebih detail
        console.log('Memulai proses build APK...');
        const buildCommand = `java -jar "${CONST.apkTool}" b "${CONST.smaliPath}" -o "${CONST.apkBuildPath}" -f -v`;
        
        try {
            await new Promise((resolve, reject) => {
                const build = cp.exec(buildCommand);
                
                build.stdout.on('data', (data) => {
                    console.log('Build output:', data);
                });

                build.stderr.on('data', (data) => {
                    console.error('Build error:', data);
                });

                build.on('close', (code) => {
                    if (code === 0) {
                        console.log('Build APK berhasil');
                        resolve();
                    } else {
                        reject(new Error(`Build gagal dengan kode: ${code}`));
                    }
                });
            });
        } catch (error) {
            throw new Error(`Gagal build APK: ${error.message}`);
        }

        // 4. Verifikasi hasil build
        if (!await checkFileExists(CONST.apkBuildPath)) {
            throw new Error('File APK tidak ditemukan setelah build');
        }

        // 5. Sign APK menggunakan zipalign terlebih dahulu
        console.log('Optimizing APK dengan zipalign...');
        const zipalignPath = path.join(CONST.factoryPath, 'zipalign');
        const alignedApk = CONST.apkBuildPath.replace('.apk', '-aligned.apk');
        
        try {
            await executeCommand(`"${zipalignPath}" -v 4 "${CONST.apkBuildPath}" "${alignedApk}"`);
            console.log('Zipalign berhasil');
            
            // Ganti file original dengan yang sudah aligned
            await fsp.rename(alignedApk, CONST.apkBuildPath);
        } catch (error) {
            console.warn('Zipalign gagal, melanjutkan ke signing:', error.message);
        }

        // 6. Sign APK dengan output yang lebih detail
        console.log('Signing APK...');
        const signCommand = `jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 -keystore "${CONST.keystore}" -storepass android -keypass android "${CONST.apkBuildPath}" androidkey`;
        
        try {
            await new Promise((resolve, reject) => {
                const sign = cp.exec(signCommand);
                
                sign.stdout.on('data', (data) => {
                    console.log('Signing output:', data);
                });

                sign.stderr.on('data', (data) => {
                    console.error('Signing error:', data);
                });

                sign.on('close', (code) => {
                    if (code === 0) {
                        console.log('Signing APK berhasil');
                        resolve();
                    } else {
                        reject(new Error(`Signing gagal dengan kode: ${code}`));
                    }
                });
            });
        } catch (error) {
            throw new Error(`Gagal sign APK: ${error.message}`);
        }

        // 7. Pindahkan dan rename APK
        console.log('Memindahkan APK ke lokasi final...');
        try {
            await fsp.copyFile(CONST.apkBuildPath, CONST.apkSignedBuildPath);
            console.log('File APK berhasil dipindahkan');
        } catch (error) {
            throw new Error(`Gagal memindahkan file APK: ${error.message}`);
        }

        // 8. Verifikasi hasil akhir
        if (!await checkFileExists(CONST.apkSignedBuildPath)) {
            throw new Error('File APK final tidak ditemukan');
        }

        console.log('Proses build APK selesai!');
        return CONST.apkSignedBuildPath;

    } catch (error) {
        console.error('Error dalam proses build:', error);
        throw new Error(`Gagal membangun APK: ${error.message}`);
    }
}

/**
 * Membersihkan file sementara setelah build
 */
async function cleanup() {
    try {
        const tempFiles = [
            CONST.apkBuildPath,
            path.join(CONST.outputPath, 'app-release-unsigned.apk')
        ];

        for (const file of tempFiles) {
            try {
                await fsp.access(file);
                await fsp.unlink(file);
                if (CONST.debug) console.log(`Berhasil menghapus: ${file}`);
            } catch {
                if (CONST.debug) console.log(`File tidak ditemukan: ${file}`);
            }
        }
    } catch (error) {
        console.warn('Gagal membersihkan file sementara:', error.message);
    }
}

module.exports = {
    buildAPK,
    patchAPK,
    cleanup,
    checkJavaVersion
};