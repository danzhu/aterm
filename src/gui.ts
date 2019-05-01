import * as child_process from 'child_process'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { once } from 'events'
import { promises as fs } from 'fs'
import { remote } from 'electron'
import { Rpc } from './rpc'
import { Queue, Sync } from './lib'

export class GUI {
    private devtools_element = document.getElementById('devtools') as HTMLButtonElement
    private output_element = document.getElementById('output') as HTMLDivElement
    private input_element = document.getElementById('input') as HTMLInputElement

    private win = remote.getCurrentWindow()
    private inputs = new Queue<string>()
    private rpc_dir: string | null = null
    private shutting_down = false
    private procs = new Set<child_process.ChildProcess>()
    private server: net.Server | null = null
    private env: NodeJS.ProcessEnv | null = null

    private proc_sync = new Sync()
    private conn_sync = new Sync()

    async run(): Promise<void> {
        window.onbeforeunload = e => {
            e.returnValue = false
            if (!this.shutting_down)
                this.shutdown()
            else // force shutdown
                this.win.destroy()
        }

        this.input_element.onkeypress = e => {
            if (e.key !== 'Enter')
                return
            this.inputs.push(this.input_element.value)
            this.input_element.value = ''
        }

        const remote_process: NodeJS.Process | undefined = remote.process
        if (remote_process === undefined)
            throw 'remote_process undefined'

        this.devtools_element.onclick = () => this.win.webContents.openDevTools()

        this.rpc_dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aterm_'))
        const rpc_path = path.join(this.rpc_dir, 'tty')
        this.server = net.createServer(socket => {
            new Rpc(socket, this)
        })
        this.server.listen(rpc_path)
        this.server.on('close', () => {
            this.server = null
            this.conn_sync.resolve()
        })
        await once(this.server, 'listening')
        console.log(`listening on ${rpc_path}`)

        this.env = remote_process.env
        this.env.ATERM = rpc_path

        // electron --no-sandbox main -- [cmd args...]
        const argv = remote_process.argv
        console.log('command-line args:', argv)
        const dash_index = argv.indexOf('--')
        if (dash_index === -1) {
            console.warn("missing '--' in command-line arguments")
        } else {
            const [cmd, ...args] = remote_process.argv.slice(dash_index + 1)
            if (cmd !== undefined)
                this.spawn(cmd, args)
        }
    }

    async input(): Promise<Queue<string>> {
        return this.inputs
    }

    async print(text: string): Promise<void> {
        const element = document.createElement('pre')
        element.textContent = text
        this.output_element.appendChild(element)
        // this.input_element.scrollIntoView()
    }

    async spawn(cmd: string, args: readonly string[]): Promise<void> {
        if (this.env === null)
            throw 'null env'
        const proc = child_process.spawn(cmd, args, {
            env: this.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        this.procs.add(proc)
        const log = (data: Buffer) => this.print(data.toString())
        const done = () => {
            this.procs.delete(proc)
            if (this.procs.size !== 0)
                return
            this.proc_sync.resolve()
            this.shutdown()
        }
        // if spawn failed, stdout and stderr are undefined;
        // however if success they will not be null, hence the assert
        if (proc.stdout !== undefined)
            proc.stdout!.on('data', log)
        if (proc.stderr !== undefined)
            proc.stderr!.on('data', log)
        proc.on('error', err => {
            this.print(`[${err}]`)
            done()
        })
        proc.on('exit', (code, _signal) => {
            this.print(`[exit ${code}]`)
            done()
        })
    }

    private async shutdown(): Promise<void> {
        if (this.shutting_down)
            return
        this.shutting_down = true

        if (this.server !== null)
            this.server.close()
        for (const proc of this.procs)
            proc.kill()

        await this.conn_sync
        if (this.rpc_dir !== null)
            await fs.rmdir(this.rpc_dir)
        if (this.procs.size > 0)
            await this.proc_sync

        this.win.destroy()
    }
}
