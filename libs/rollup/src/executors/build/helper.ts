import { Observable } from 'rxjs'

export class Deferred<T> {
    resolve: (value: T | PromiseLike<T>) => void = null!
    reject: (reason?: any) => void = null!
    promise = new Promise<T>((a, b) => {
        this.resolve = a
        this.reject = b
    })
}

export async function* eachValueFrom<T>(
    source: Observable<T>,
): AsyncIterableIterator<T> {
    const deferreds: Deferred<IteratorResult<T>>[] = []
    const values: T[] = []
    let hasError = false
    let error: any = null
    let completed = false

    const subs = source.subscribe({
        next: (value) => {
            if (deferreds.length > 0) {
                deferreds.shift()!.resolve({ value, done: false })
            } else {
                values.push(value)
            }
        },
        error: (err) => {
            hasError = true
            error = err
            while (deferreds.length > 0) {
                deferreds.shift()!.reject(err)
            }
        },
        complete: () => {
            completed = true
            while (deferreds.length > 0) {
                deferreds.shift()!.resolve({ value: undefined, done: true })
            }
        },
    })

    try {
        while (true) {
            if (values.length > 0) {
                yield values.shift()!
            } else if (completed) {
                return
            } else if (hasError) {
                throw error
            } else {
                const d = new Deferred<IteratorResult<T>>()
                deferreds.push(d)
                const result = await d.promise
                if (result.done) {
                    return
                } else {
                    yield result.value
                }
            }
        }
    } catch (err) {
        throw err
    } finally {
        subs.unsubscribe()
    }
}
