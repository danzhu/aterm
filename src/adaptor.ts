import * as net from 'net'
import * as process from 'process'
import * as child_process from 'child_process'

const main = async () => {
    const ipc_path = process.env.ATERM
    if (ipc_path === undefined) {
        console.error('cannot open terminal')
        return process.exit(2)
    }

    const connection = net.createConnection(ipc_path, () => {
        const [, , cmd, ...args] = process.argv
        const proc = child_process.spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'inherit'],
        })
        proc.stdout!.on('data', data => connection.write(data))
        proc.on('error', err => console.log(`Error ${err}`))
        proc.on('exit', () => connection.destroy())
        connection.on('data', data => proc.stdin!.write(data))
    })
}

main()
