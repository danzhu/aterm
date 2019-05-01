import * as net from 'net'
import * as process from 'process'
import { once } from 'events'
import { Rpc } from './rpc'
import { GUI } from './gui'

const main = async () => {
    const rpc_path = process.env.ATERM
    if (rpc_path === undefined) {
        console.error('cannot open terminal')
        return process.exit(2)
    }

    const connection = net.createConnection(rpc_path)
    await once(connection, 'connect')
    const rpc = new Rpc<GUI>(connection)
    const ui = rpc.remote

    const input = await ui.input()
    while (true) {
        const text = await input.pop()
        ui.print(text)
        const [cmd, ...args] = text.trim().split(' ')
        if (cmd === 'exit')
            break
        ui.spawn(cmd, args)
    }

    connection.end()
}

main()
