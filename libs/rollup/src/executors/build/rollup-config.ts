import 'dotenv/config'
import * as ts from 'typescript'
import * as rollup from 'rollup'
import * as path from 'path'
import * as peerDepsExternal from 'rollup-plugin-peer-deps-external'
import { getBabelInputPlugin } from '@rollup/plugin-babel'
import * as autoprefixer from 'autoprefixer'
import type { ExecutorContext } from '@nrwl/devkit'
import { joinPathFragments, names } from '@nrwl/devkit'
import {
    computeCompilerOptionsPaths,
    DependentBuildableProjectNode,
} from '@nrwl/workspace/src/utilities/buildable-libs-utils'
import resolve from '@rollup/plugin-node-resolve'

import { AssetGlobPattern } from './schema'
import { NormalizedRollupExecutorOptions } from './lib/normalize'
import { analyze } from './lib/analyze-plugin'
import { swc } from './lib/swc-plugin'
import { glob } from 'glob'

const commonjs = require('@rollup/plugin-commonjs')
const image = require('@rollup/plugin-image')

const json = require('@rollup/plugin-json')
const copy = require('rollup-plugin-copy')
const postcss = require('rollup-plugin-postcss')

const fileExtensions = ['.js', '.jsx', '.ts', '.tsx']

export function createRollupOptions(
    options: NormalizedRollupExecutorOptions,
    dependencies: DependentBuildableProjectNode[],
    context: ExecutorContext,
    packageJson: any,
    sourceRoot: string,
    npmDeps: string[],
): {
    inputs: Record<string, any>
    rollupConfigs: rollup.InputOptions[]
} {
    const useBabel = options.compiler === 'babel'
    const useTsc = options.compiler === 'tsc'
    const useSwc = options.compiler === 'swc'

    const tsConfigPath = joinPathFragments(context.root, options.tsConfig)
    const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile)
    const config = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsConfigPath),
    )

    if (!options.format || !options.format.length) {
        options.format = readCompatibleFormats(config)
    }

    let inputs: Record<string, any> = {}

    const rollupConfigs = options.format.map((format) => {
        const plugins = [
            copy({
                targets: convertCopyAssetsToRollupOptions(
                    options.outputPath,
                    options.assets,
                ),
            }),
            image(),
            json(),
            (useTsc || useBabel) &&
                require('rollup-plugin-typescript2')({
                    check: true,
                    tsconfig: options.tsConfig,
                    tsconfigOverride: {
                        compilerOptions: createTsCompilerOptions(
                            config,
                            dependencies,
                            options,
                        ),
                    },
                }),
            peerDepsExternal({
                packageJsonPath: options.project,
            }),
            postcss({
                inject: true,
                extract: options.extractCss,
                autoModules: true,
                plugins: [autoprefixer],
                use: {
                    less: {
                        javascriptEnabled: options.javascriptEnabled,
                    },
                },
            }),
            resolve({
                preferBuiltins: true,
                extensions: fileExtensions,
            }),
            useSwc && swc(),
            useBabel &&
                getBabelInputPlugin({
                    // Lets `@nrwl/js/babel` preset know that we are packaging.
                    caller: {
                        // @ts-ignore
                        // Ignoring type checks for caller since we have custom attributes
                        isNxPackage: true, // Always target esnext and let rollup handle cjs
                        supportsStaticESM: true,
                        isModern: true,
                    },
                    cwd: path.join(context.root, sourceRoot),
                    rootMode: 'upward',
                    babelrc: true,
                    extensions: fileExtensions,
                    babelHelpers: 'bundled',
                    skipPreflightCheck: true, // pre-flight check may yield false positives and also slows down the build
                    exclude: /node_modules/,
                    plugins: [
                        format === 'esm'
                            ? undefined
                            : require.resolve(
                                  'babel-plugin-transform-async-to-promises',
                              ),
                    ].filter(Boolean),
                }),
            commonjs(),
            analyze(),
        ]

        const externalPackages = dependencies
            .map((d) => d.name)
            .concat(options.external || [])
            .concat(Object.keys(packageJson.dependencies || {}))

        const rollupConfig = {
            input: options.outputFileName
                ? {
                      [path.parse(options.outputFileName).name]: options.main,
                  }
                : options.main,
            output: {
                format,
                dir: `${options.outputPath}`,
                name: names(context.projectName).className,
                entryFileNames: `[name].${format === 'esm' ? 'js' : 'cjs'}`,
                chunkFileNames: `[name].${format === 'esm' ? 'js' : 'cjs'}`,
            },
            external: (id) =>
                externalPackages.some(
                    (name) => id === name || id.startsWith(`${name}/`),
                ) ||
                npmDeps.some(
                    (name) => id === name || id.startsWith(`${name}/`),
                ), // Could be a deep import
            plugins,
        }

        const combineConfig = options.rollupConfig.reduce(
            (currentConfig, plugin) => {
                return require(plugin)(currentConfig, options)
            },
            rollupConfig,
        )

        const basePath = combineConfig.input.replace('/src/index.ts', '')

        const files = glob.sync('src/**/*.ts', {
            cwd: basePath,
            root: path.resolve(basePath, '/'),
        })

        inputs = files.reduce((result, input) => {
            const key = input.replace('.ts', '')
            result[key] = path.join(basePath, input)
            return result
        }, {})

        return combineConfig
    })

    return {
        inputs,
        rollupConfigs,
    }
}

function createTsCompilerOptions(
    config: ts.ParsedCommandLine,
    dependencies,
    options,
) {
    const compilerOptionPaths = computeCompilerOptionsPaths(
        config,
        dependencies,
    )
    const compilerOptions = {
        rootDir: options.projectRoot,
        allowJs: false,
        declaration: true,
        paths: compilerOptionPaths,
    }
    if (config.options.module === ts.ModuleKind.CommonJS) {
        compilerOptions['module'] = 'ESNext'
    }
    return compilerOptions
}

interface RollupCopyAssetOption {
    src: string
    dest: string
}

function convertCopyAssetsToRollupOptions(
    outputPath: string,
    assets: AssetGlobPattern[],
): RollupCopyAssetOption[] {
    return assets
        ? assets.map((a) => ({
              src: path.join(a.input, a.glob).replace(/\\/g, '/'),
              dest: path.join(outputPath, a.output).replace(/\\/g, '/'),
          }))
        : undefined
}

function readCompatibleFormats(config: ts.ParsedCommandLine) {
    switch (config.options.module) {
        case ts.ModuleKind.CommonJS:
        case ts.ModuleKind.UMD:
        case ts.ModuleKind.AMD:
            return ['cjs']
        default:
            return ['esm']
    }
}
