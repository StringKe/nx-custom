import 'dotenv/config'
import { RollupExecutorOptions } from './schema'
import type { ExecutorContext } from '@nrwl/devkit'
import { logger, readJsonFile } from '@nrwl/devkit'
import { from, Observable, of } from 'rxjs'
import { catchError, concatMap, last, scan, tap } from 'rxjs/operators'
import { calculateProjectDependencies } from '@nrwl/workspace/src/utilities/buildable-libs-utils'
import { normalizeRollupExecutorOptions } from './lib/normalize'
import { createRollupOptions } from './rollup-config'
import { validateTypes } from './lib/validate-types'
import { deleteOutputDir } from './lib/delete-output-dir'
import * as rollup from 'rollup'
import { runRollup } from './lib/run-rollup'
import { updatePackageJson } from './lib/update-package-json'
import { eachValueFrom } from './helper'
import * as process from 'process'

// noinspection JSUnusedGlobalSymbols
export default async function runExecutor(
    rawOptions: RollupExecutorOptions,
    context: ExecutorContext,
) {
    process.env.NODE_ENV ??= 'production'

    const project = context.projectsConfigurations.projects[context.projectName]
    const sourceRoot = project.sourceRoot
    const { target, dependencies } = calculateProjectDependencies(
        context.projectGraph,
        context.root,
        context.projectName,
        context.targetName,
        context.configurationName,
        true,
    )

    const options = normalizeRollupExecutorOptions(
        rawOptions,
        context.root,
        sourceRoot,
    )

    const packageJson = readJsonFile(options.project)

    const npmDeps = (
        context.projectGraph.dependencies[context.projectName] ?? []
    )
        .filter((d) => d.target.startsWith('npm:'))
        .map((d) => d.target.slice(4))

    const { rollupConfigs: rollupOptions, inputs } = createRollupOptions(
        options,
        dependencies,
        context,
        packageJson,
        sourceRoot,
        npmDeps,
    )

    if (options.compiler === 'swc') {
        try {
            await validateTypes({
                workspaceRoot: context.root,
                projectRoot: options.projectRoot,
                tsconfig: options.tsConfig,
            })
        } catch {
            return { success: false }
        }
    }

    if (options.watch) {
        const watcher = rollup.watch(rollupOptions)

        const obs$ = new Observable<{ success: boolean }>((obs) => {
            watcher.on('event', (data) => {
                if (data.code === 'START') {
                    logger.info(`Bundling ${context.projectName}...`)
                } else if (data.code === 'END') {
                    updatePackageJson(
                        options,
                        context,
                        target,
                        dependencies,
                        packageJson,
                        inputs,
                    )
                    logger.info('Bundle complete. Watching for file changes...')
                    obs.next({ success: true })
                } else if (data.code === 'ERROR') {
                    logger.error(`Error during bundle: ${data.error.message}`)
                    obs.next({ success: false })
                }
            })
            // Teardown logic. Close watcher when unsubscribed.
            return () => watcher.close()
        })

        return eachValueFrom<{ success: boolean }>(obs$)
    } else {
        logger.info(`Bundling ${context.projectName}...`)

        // Delete output path before bundling
        if (options.deleteOutputPath) {
            deleteOutputDir(context.root, options.outputPath)
        }

        const start = process.hrtime.bigint()

        return from(rollupOptions)
            .pipe(
                concatMap((opts) =>
                    runRollup(opts).pipe(
                        catchError((e) => {
                            logger.error(`Error during bundle: ${e}`)
                            return of({ success: false })
                        }),
                    ),
                ),
                scan(
                    (acc, result) => {
                        if (!acc.success) return acc
                        return result
                    },
                    { success: true },
                ),
                last(),
                tap({
                    next: (result) => {
                        if (result.success) {
                            const end = process.hrtime.bigint()
                            const duration = `${(
                                Number(end - start) / 1_000_000_000
                            ).toFixed(2)}s`

                            updatePackageJson(
                                options,
                                context,
                                target,
                                dependencies,
                                packageJson,
                                inputs,
                            )
                            logger.info(`⚡ Done in ${duration}`)
                        } else {
                            logger.error(
                                `Bundle failed: ${context.projectName}`,
                            )
                        }
                    },
                }),
            )
            .toPromise()
    }
}
