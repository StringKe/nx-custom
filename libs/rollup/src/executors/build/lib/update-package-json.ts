import { relative } from 'path'
import { ExecutorContext } from 'nx/src/config/misc-interfaces'
import { ProjectGraphProjectNode } from 'nx/src/config/project-graph'
import {
    DependentBuildableProjectNode,
    updateBuildableProjectPackageJsonDependencies,
} from '@nrwl/workspace/src/utilities/buildable-libs-utils'
import { writeJsonFile } from 'nx/src/utils/fileutils'
import { PackageJson } from 'nx/src/utils/package-json'
import { NormalizedRollupExecutorOptions } from './normalize'

export function updatePackageJson(
    options: NormalizedRollupExecutorOptions,
    context: ExecutorContext,
    target: ProjectGraphProjectNode,
    dependencies: DependentBuildableProjectNode[],
    packageJson: PackageJson,
    inputs: Record<string, string>,
) {
    const hasEsmFormat = options.format.includes('esm')
    const hasCjsFormat = options.format.includes('cjs')

    const exports = {}

    packageJson.type = options.format.includes('esm') ? 'module' : 'commonjs'

    // packageJson.types = types

    let indexType = {
        types: './src/index.d.ts',
        import: './src/index.js',
        require: './src/index.cjs',
    }

    Object.keys(inputs).forEach((input) => {
        const value = input
        const relativePath = value.replace('src/', '')
        exports[relativePath] = {
            types: `./${value}.d.ts`,
        }
        if (hasEsmFormat) {
            exports[relativePath].import = `./${value}.js`
        }
        if (hasCjsFormat) {
            exports[relativePath].require = `./${value}.cjs`
        }
        if (relativePath === 'index') {
            indexType = exports[relativePath]
        }
    })
    packageJson.types = indexType.types
    if (hasEsmFormat) {
        packageJson.module = indexType.import
    }
    if (hasCjsFormat) {
        packageJson.main = indexType.require
    }
    exports['.'] = indexType

    // sort exports

    // TODO(jack): remove this for Nx 16
    if (
        options.generateExportsField &&
        typeof packageJson.exports !== 'string'
    ) {
        packageJson.exports = {
            ...packageJson.exports,
            ...exports,
        }
    }

    packageJson.exports = Object.keys(packageJson.exports)
        .sort()
        .reduce((acc, key) => {
            acc[key] = packageJson.exports[key]
            return acc
        }, {})

    writeJsonFile(`${options.outputPath}/package.json`, packageJson)

    if (
        dependencies.length > 0 &&
        options.updateBuildableProjectDepsInPackageJson
    ) {
        updateBuildableProjectPackageJsonDependencies(
            context.root,
            context.projectName,
            context.targetName,
            context.configurationName,
            target,
            dependencies,
            options.buildableProjectDepsInPackageJsonType,
        )
    }
}
