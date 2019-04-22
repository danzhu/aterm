import * as child_process from 'child_process'
import * as net from 'net'
import * as process from 'process'
import { Msg, Rpc, RpcError } from './rpc'

const main = async () => {
    const rpc_server = {
        input(rpc: Rpc, { text }: Msg<'text'>) {
            if (typeof text !== 'string')
                throw new RpcError('expect string text')

            rpc.request('log', { text })
            const [cmd, ...args] = text.split(' ')

            if (cmd === 'exit')
                process.exit()

            const proc = child_process.spawn(cmd, args)
            proc.on('error', err => {
                rpc.request('log', { text: `Error: ${err.message}` })
            })
            proc.stdout.on('data', (data: Buffer) => {
                rpc.request('log', { text: data.toString() })
            })
            proc.stderr.on('data', (data: Buffer) => {
                rpc.request('log', { text: data.toString() })
            })
            proc.on('exit', (code, _signal) => {
                const text = `[exit: ${code}]`
                rpc.request('log', { text })
            })
        }
    }

    const ipc_path = process.env.ATERM
    if (ipc_path === undefined) {
        console.error('cannot open terminal')
        return process.exit(2)
    }

    const connection = net.createConnection(ipc_path, () => {
        const rpc = new Rpc(connection, rpc_server)
        rpc.request('log', { text: 'init' })
    })
}

main()
