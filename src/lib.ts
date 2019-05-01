export type Any = number | string | boolean | symbol | object | null | undefined

export class Sync<T> implements PromiseLike<T> {
    private value: Promise<T>
    resolve!: (value?: T | PromiseLike<T>) => void
    reject!: (reason?: any) => void

    constructor() {
        this.value = new Promise((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }

    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined)
        : PromiseLike<TResult1 | TResult2> {
        return this.value.then(onfulfilled, onrejected)
    }
}

export class Queue<T> {
    private buffer: T[] = []
    private wait: Sync<T>[] = []

    push(value: T) {
        if (this.wait.length > 0)
            this.wait.shift()!.resolve(value)
        else
            this.buffer.push(value)
    }

    async pop(): Promise<T> {
        if (this.buffer.length > 0)
            return this.buffer.shift()!
        const sync = new Sync<T>()
        this.wait.push(sync)
        return await sync
    }
}

export class DualMap<K, V> {
    private forward = new Map<K, V>()
    private backward = new Map<V, K>()

    add(key: K, value: V) {
        // TODO: check if already in map to prevent multi-key/value
        this.forward.set(key, value)
        this.backward.set(value, key)
    }

    has_key(key: K): boolean {
        return this.forward.has(key)
    }

    has_value(value: V): boolean {
        return this.backward.has(value)
    }

    get_value(key: K): V | undefined {
        return this.forward.get(key)
    }

    get_key(value: V): K | undefined {
        return this.backward.get(value)
    }
}
