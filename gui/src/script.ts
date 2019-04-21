import * as assert from 'assert'
import * as child_process from 'child_process'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { promises as fs } from 'fs'
import { remote } from 'electron'
import { Msg, Rpc, RpcError } from './rpc'

export = async () => {
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

    const connect = (socket: net.Socket) => {
        const rpc = new Rpc(socket, rpc_server)

        input.onkeypress = e => {
            if (e.key !== 'Enter')
                return
            rpc.request('input', { text: input.value })
            input.value = ''
        }
    }

    const rpc_dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aterm_'))
    const rpc_path = path.join(rpc_dir, 'tty')
    const connection = net.createServer(connect)
    connection.listen(rpc_path, () => console.log(`listening on ${rpc_path}`))
    connection.on('close', () => fs.rmdir(rpc_dir))
    const win = remote.getCurrentWindow()
    win.on('close', () => connection.close())

    devtools.onclick = () => win.webContents.openDevTools()

    const remote_process: NodeJS.Process = remote.process
    assert(remote_process !== undefined)
    // electron main [cmd args...]
    const [cmd, ...args] = remote_process.argv.slice(2)
    const env = remote_process.env
    env.ATERM = rpc_path
    const proc = child_process.spawn(cmd, args, { stdio: 'inherit', env })
    proc.on('exit', (_code, _signal) => win.close())
}
