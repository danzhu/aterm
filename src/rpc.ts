import * as net from 'net'

export type Any = number | string | boolean | symbol | object | null | undefined
export type Msg<K extends keyof any> = {
    [P in K]?: Any
}

export interface Handler {
    (rpc: Rpc, args: object): PromiseLike<object> | void
}

export interface Server {
    [method: string]: Handler | undefined
}

interface Request {
    id: string
    method: string
    args: object
}

interface Response {
    id: string
    result?: object
    error?: string
}

type Outgoing = Request | Response
type Incoming = Msg<keyof (Request & Response)>

interface Pending<T, E> {
    resolve(res?: T | PromiseLike<T>): void
    reject(err?: E): void
}

export class RpcError extends Error {}

export class Rpc {
    buffer = ''
    next_id = 0
    pending = new Map<string, Pending<object, string>>()

    constructor(public connection: net.Socket, public server: Server) {
        connection.on('data', data => this.receive(data))
    }

    receive(data: Buffer) {
        this.buffer += data.toString()
        const lines = this.buffer.split('\n')
        if (lines.length === 0)
            throw 'split returns empty array'
        this.buffer = lines.pop()!
        for (const line of lines) {
            this.handle(line)
        }
    }

    async handle(line: string) {
        let msg_id: string | null = null
        try {
            const msg: Any = JSON.parse(line)
            if (typeof msg !== 'object' || msg === null)
                throw new RpcError('expect object message')
            const { id, method, args, result, error }: Incoming = msg
            if (typeof id !== 'string')
                throw new RpcError('expect string id')
            msg_id = id
            if (typeof method === 'string') {
                if (typeof args !== 'object' || args === null)
                    throw new RpcError('expect object args')
                const handler = this.server[method]
                if (handler === undefined)
                    throw new RpcError('unknown method')
                const ret = handler(this, args)
                const result = ret !== undefined ? await ret : {}
                this.send({ id, result })
            } else {
                const request = this.pending.get(id)
                if (request === undefined)
                    throw new RpcError('unknown id')
                if (typeof result === 'object' && result !== null)
                    request.resolve(result)
                else if (typeof error === 'string')
                    request.reject(error)
                else
                    throw new RpcError('expect object result or string error')
                this.pending.delete(id)
            }
        } catch (error) {
            if (error instanceof SyntaxError)
                return
            if (error instanceof RpcError) {
                if (msg_id !== null)
                    this.error(msg_id, error.message)
                return
            }
            throw error
        }
    }

    send(msg: Outgoing) {
        const data = JSON.stringify(msg)
        if (data.indexOf('\n') !== -1)
            throw 'json contains newline'
        this.connection.write(data + '\n')
    }

    request(method: string, args: object): Promise<object> {
        const id = (this.next_id++).toString()
        this.send({ id, method, args })
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
        })
    }

    respond(id: string, result: object) {
        this.send({ id, result })
    }

    error(id: string, error: string) {
        this.send({ id, error })
    }
}
