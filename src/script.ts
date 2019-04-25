import * as child_process from 'child_process'
import * as events from 'events'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { remote } from 'electron'
import { Msg, Rpc, RpcError } from './rpc'

function once(emitter: events.EventEmitter, event: string | symbol): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const event_handler = (...args: any[]) => {
            emitter.removeListener('error', error_handler)
            resolve(args)
        }
        const error_handler = (err: any) => {
            emitter.removeListener(event, event_handler)
            reject(err)
        }
        emitter.once(event, event_handler)
        emitter.once('error', error_handler)
    })
}

class Sync<T> implements PromiseLike<T> {
    value: Promise<T>
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

export = class Main {
    output = document.getElementById('output') as HTMLDivElement
    input = document.getElementById('input') as HTMLInputElement
    devtools = document.getElementById('devtools') as HTMLButtonElement

    win = remote.getCurrentWindow()
    rpc_dir: string | null = null
    shutting_down = false
    procs: Set<child_process.ChildProcess> = new Set()
    connection: net.Server | null = null
    env: NodeJS.ProcessEnv | null = null

    proc_sync = new Sync()
    conn_sync = new Sync()

    async run() {
        const self = this
        const rpc_server = {
            log(_rpc: Rpc, { text }: Msg<'text'>) {
                if (typeof text !== 'string')
                    throw new RpcError('expect string text')
                self.log(text)
            },
            spawn(_rpc: Rpc, { cmd, args }: Msg<'cmd' | 'args'>) {
                if (typeof cmd !== 'string')
                    throw new RpcError('expect string cmd')
                if (!Array.isArray(args))
                    throw new RpcError('expect string cmd')
                self.spawn(cmd, args)
            },
        }

        window.onbeforeunload = e => {
            e.returnValue = false
            if (!this.shutting_down)
                this.shutdown()
            else // force shutdown
                this.win.destroy()
        }

        const remote_process: NodeJS.Process | undefined = remote.process
        if (remote_process === undefined)
            throw 'remote_process undefined'

        this.devtools.onclick = () => this.win.webContents.openDevTools()

        this.rpc_dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aterm_'))
        const rpc_path = path.join(this.rpc_dir, 'tty')
        this.connection = net.createServer(socket => {
            const rpc = new Rpc(socket, rpc_server)

            this.input.onkeypress = e => {
                if (e.key !== 'Enter')
                    return
                rpc.request('input', { text: this.input.value })
                this.input.value = ''
            }
        })
        this.connection.listen(rpc_path)
        this.connection.on('close', () => {
            this.connection = null
            this.conn_sync.resolve()
        })
        await once(this.connection, 'listening')
        console.log(`listening on ${rpc_path}`)

        this.env = remote_process.env
        this.env.ATERM = rpc_path

        // electron main [cmd args...]
        const [, , cmd, ...args] = remote_process.argv
        if (cmd !== undefined)
            this.spawn(cmd, args)
    }

    log(text: string) {
        const element = document.createElement('pre')
        element.textContent = text
        this.output.appendChild(element)
        this.input.scrollIntoView()
    }

    spawn(cmd: string, args: string[]) {
        if (this.env === null)
            throw 'null env'
        const proc = child_process.spawn(cmd, args, {
            env: this.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        this.procs.add(proc)
        const log = (data: Buffer) => this.log(data.toString())
        const done = () => {
            this.procs.delete(proc)
            if (this.procs.size !== 0)
                return
            this.proc_sync.resolve()
            this.shutdown()
        }
        proc.stdout!.on('data', log)
        proc.stderr!.on('data', log)
        proc.on('error', err => {
            this.log(`[${err}]`)
            done()
        })
        proc.on('exit', (code, _signal) => {
            this.log(`[exit ${code}]`)
            done()
        })
    }

    async shutdown() {
        if (this.shutting_down)
            return
        this.shutting_down = true

        if (this.connection !== null)
            this.connection.close()
        for (const proc of this.procs)
            proc.kill()

        await this.conn_sync
        if (this.rpc_dir !== null)
            await fs.rmdir(this.rpc_dir)
        await this.proc_sync

        this.win.destroy()
    }
}
