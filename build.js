/**
 * st-immersive-sound 构建脚本
 *
 * 把 index.src.js（入口源码）+ utils/ 打包为 index.js（不做混淆）。
 *
 *   用法：npm run build
 *
 * 背景：原始仓库只发布了混淆后的 index.js，构建脚本与入口源码均未提交。
 * 本脚本 + index.src.js 补上了这条缺失的链路。
 *
 * 为什么不混淆：javascript-obfuscator 的 seed 参数实际不生效（4.1.1 实测
 * 忽略），每次构建产物全量变化、git diff 无法审阅，且实测会偶发产出
 * 损坏产物（字符串表不一致导致运行时 "not a constructor"）。本插件是
 * 自用 fork，混淆没有收益，产物保持 esbuild 的可读输出、字节级可复现。
 *
 * 外部依赖（../../../extensions.js 等）由 SillyTavern 宿主提供，保持 external。
 */

import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// SillyTavern 宿主提供的模块，不打进产物。
// 这些路径是**相对入口文件**（index.src.js，位于插件根目录）的写法。
const EXTERNAL = [
    '../../../extensions.js',
    '../../../../script.js',
    '../../../st-context.js',
];

// utils/ 下的文件层级更深，它们写的是 ../../../../../script.js（5 层）
// 这类路径。必须把这些写法**归一化到入口层级**再交给 esbuild，
// 否则 esbuild 会把它们当成“未声明外部的相对路径”而按源码文件所在
// 层级重写，产出 ../../../script.js 这种在插件根目录下并不存在的位置，
// 运行时直接 import 失败。
//
// 注意：这个 bug 在 macOS 上不必然复现、在 Linux 上必现，属于
// “同一份源码在不同平台构建出不同产物”的隐蔽缺陷，因此这里显式归一化，
// 不依赖 esbuild 的默认行为。
const HOST_MODULE = /^(?:\.\.\/)+((?:extensions|script|st-context)\.js)$/;

/** @type {import('esbuild').Plugin} */
const normalizeHostImports = {
    name: 'normalize-host-imports',
    setup(build) {
        build.onResolve({ filter: /^(?:\.\.\/)+(?:extensions|script|st-context)\.js$/ }, (args) => {
            const matched = args.path.match(HOST_MODULE);
            if (!matched) return null;
            const filename = matched[1];
            const normalized = EXTERNAL.find((spec) => spec.endsWith(`/${filename}`));
            if (!normalized) return null;
            return { path: normalized, external: true };
        });
    },
};

async function main() {
    // 1) 打包
    const result = await build({
        entryPoints: [join(root, 'index.src.js')],
        bundle: true,
        format: 'esm',
        write: false,
        external: EXTERNAL,
        plugins: [normalizeHostImports],
        logLevel: 'warning',
        charset: 'utf8',
        metafile: true,
    });

    const bundled = result.outputFiles[0].text;
    console.log(`[build] esbuild 打包完成：${bundled.length} 字节`);

    // 1b) 校验：所有宿主模块 import 必须落在入口层级，否则运行时会 404。
    //     留在产物里的相对路径只有这几种合法写法。
    const LEGAL = new Set(EXTERNAL);
    const specifiers = [...bundled.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    const illegal = [...new Set(specifiers)].filter(
        (spec) => spec.startsWith('.') && !LEGAL.has(spec),
    );
    if (illegal.length > 0) {
        throw new Error(
            `发现未归一的相对导入（运行时会解析失败）：\n  ${illegal.join('\n  ')}\n` +
            '请检查 build.js 的 EXTERNAL / normalizeHostImports 是否覆盖了该层级。',
        );
    }
    console.log(`[build] 宿主导入校验通过：${new Set(specifiers).size} 个不同来源，全部合法`);

    // 2) 写出（esbuild 输出本身确定：同一份源码永远产出字节相同的 index.js）
    writeFileSync(join(root, 'index.js'), bundled, 'utf8');
    console.log(`[build] 已写出 index.js（${bundled.length} 字节，未混淆、可复现）`);
}

main().catch((err) => {
    console.error('[build] 失败：', err);
    process.exit(1);
});
