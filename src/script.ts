import * as assert from 'assert'
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

class Sync<T> {
    value: Promise<T>
    resolve!: (value?: T | PromiseLike<T>) => void
    reject!: (reason?: any) => void

    constructor() {
        this.value = new Promise((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }
}

export = class Main {
    win = remote.getCurrentWindow()
    rpc_dir: string | null = null
    shutting_down = false
    proc: child_process.ChildProcess | null = null
    connection: net.Server | null = null

    proc_sync = new Sync()
    conn_sync = new Sync()

    async run() {
        const output = document.getElementById('output') as HTMLDivElement
        const input = document.getElementById('input') as HTMLInputElement
        const devtools = document.getElementById('devtools') as HTMLButtonElement

        const rpc_server = {
            log(_rpc: Rpc, { text }: Msg<'text'>) {
                if (typeof text !== 'string')
                    throw new RpcError('expect string text')
                const element = document.createElement('pre')
                element.textContent = text
                output.appendChild(element)
                input.scrollIntoView()
            }
        }

        window.onbeforeunload = e => {
            e.returnValue = false
            if (!this.shutting_down)
                this.shutdown()
            else // force shutdown
                this.win.destroy()
        }

        const remote_process: NodeJS.Process = remote.process
        assert(remote_process !== undefined)

        devtools.onclick = () => this.win.webContents.openDevTools()

        this.rpc_dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aterm_'))
        const rpc_path = path.join(this.rpc_dir, 'tty')
        this.connection = net.createServer(socket => {
            const rpc = new Rpc(socket, rpc_server)

            input.onkeypress = e => {
                if (e.key !== 'Enter')
                    return
                rpc.request('input', { text: input.value })
                input.value = ''
            }
        })
        this.connection.listen(rpc_path)
        this.connection.on('close', () => {
            this.connection = null
            this.conn_sync.resolve()
        })
        await once(this.connection, 'listening')
        console.log(`listening on ${rpc_path}`)

        const env = remote_process.env
        env.ATERM = rpc_path

        // electron main [cmd args...]
        const [, , cmd, ...args] = remote_process.argv
        if (cmd !== undefined) {
            this.proc = child_process.spawn(cmd, args, { env })
            this.proc.stdout!.on('data', console.log)
            this.proc.stderr!.on('data', console.log)
            this.proc.on('error', console.log)
            this.proc.on('exit', (_code, _signal) => {
                this.proc = null
                this.proc_sync.resolve()
                this.shutdown()
            })
        }

    }

    async shutdown() {
        if (this.shutting_down)
            return
        this.shutting_down = true
        if (this.proc !== null)
            this.proc.kill()
        if (this.connection !== null)
            this.connection.close()
        await this.proc_sync.value
        await this.conn_sync.value
        if (this.rpc_dir !== null)
            await fs.rmdir(this.rpc_dir)
        this.win.destroy()
    }
}
