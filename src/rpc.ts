import * as net from 'net'
import { Any, DualMap, Sync } from './lib'

type Json = number | string | boolean | null | JsonArray | JsonObject
type JsonArray = {
    [index: number]: Json
}
type JsonObject = {
    [key: string]: Json
}

export type Msg<K extends keyof any> = {
    [P in K]?: Json
}

export interface HandlerMethod {
    (...args: any[]): Promise<any>
}

// export type Handler<T> = {
//     [P in keyof T]: T[P] extends HandlerMethod ? T[P] : never
// }

interface Marshall {
    id: string
    remote: boolean
}

type Ser = number | string | boolean | null | Marshall | SerArray
interface SerArray {
    [index: number]: Ser
}

interface Request {
    id: string
    method: string
    self: Marshall
    args: Ser[]
}

interface Response {
    id: string
    result: Ser
}

interface Error {
    id: string
    error: Ser
}

type Outgoing = Request | Response | Error
type Incoming = Msg<keyof (Request & Response & Error)>

interface Remote {
    (): void
    id: string
}

export class RpcError extends Error {}

export class Rpc<T extends object> {
    private buffer = ''
    private next_request = 0
    private pending = new Map<string, Sync<Any>>()
    private next_marshall = 0
    private marshalls = new DualMap<string, object>()
    private remotes = new DualMap<string, object>()
    private remote_handler: ProxyHandler<Remote>

    public remote: T

    constructor(public connection: net.Socket, public handler: object = {}) {
        const rpc = this
        this.remote_handler = {
            apply(target, _self, args) {
                return rpc.request('()', target.id, args)
            },

            get(target, prop, _receiver): ((...args: Any[]) => Promise<Any>) | undefined {
                if (typeof prop !== 'string')
                    return undefined
                // HACK: js checks for then when resolving promises,
                // we don't want to send the request over rpc
                if (prop === 'then')
                    return undefined
                return (...args: Any[]) => rpc.request(prop, target.id, args)
            },
        }
        this.remote = this.new_remote('main') as T
        this.marshalls.add("main", handler)
        connection.on('data', data => this.receive(data))
    }

    private receive(data: Buffer) {
        this.buffer += data.toString()
        const lines = this.buffer.split('\n')
        if (lines.length === 0)
            throw 'split returns empty array'
        this.buffer = lines.pop()!
        for (const line of lines) {
            this.handle(line)
        }
    }

    private async handle(line: string) {
        let msg_id: string | null = null
        try {
            const msg: Json = JSON.parse(line)
            if (typeof msg !== 'object' || msg === null)
                throw new RpcError('expect object message')
            const { id, method, self, args, result, error }: Incoming = msg
            if (typeof id !== 'string')
                throw new RpcError('expect string id')
            msg_id = id
            if (method !== undefined) {
                if (typeof method !== 'string')
                    throw new RpcError('expect string method')
                if (!Array.isArray(args))
                    throw new RpcError('expect array args')
                if (typeof self !== 'object' || self === null)
                    throw new RpcError('expect object self')
                const de_self: any = this.deserialize(self)
                const handler: HandlerMethod | undefined =
                    method === '()' ? de_self : de_self[method]
                if (handler === undefined)
                    throw new RpcError('unknown method')
                const de_args = args.map(a => this.deserialize(a))
                const ret = await handler.apply(de_self, de_args)
                this.respond(id, ret)
            } else {
                const request = this.pending.get(id)
                if (request === undefined)
                    throw new RpcError('unknown id')
                if (result !== undefined)
                    request.resolve(this.deserialize(result))
                else if (error !== undefined)
                    request.reject(this.deserialize(error))
                else
                    throw new RpcError('expect array result or string error')
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

    private send(msg: Outgoing) {
        const data = JSON.stringify(msg)
        if (data.indexOf('\n') !== -1)
            throw 'json contains newline'
        this.connection.write(data + '\n')
    }

    async request(method: string, self_id: string, args: Any[]): Promise<Any> {
        const request_id = this.next_request.toString()
        ++this.next_request
        this.send({
            id: request_id,
            method,
            self: { id: self_id, remote: false },
            args: args.map(a => this.serialize(a)),
        })
        const sync = new Sync<Any>()
        this.pending.set(request_id, sync)
        return await sync
    }

    respond(id: string, result: Any) {
        this.send({ id, result: this.serialize(result) })
    }

    error(id: string, error: Any) {
        this.send({ id, error: this.serialize(error) })
    }

    private marshall(data: object): Marshall {
        if (this.remotes.has_value(data)) {
            const id = this.remotes.get_key(data)!
            return { id, remote: false }
        } else {
            if (!this.marshalls.has_value(data)) {
                const id = this.next_marshall.toString()
                ++this.next_marshall
                this.marshalls.add(id, data)
            }
            const id = this.marshalls.get_key(data)!
            return { id, remote: true }
        }
    }

    private unmarshall({ id, remote }: Msg<keyof Marshall>): object | undefined {
        if (typeof id !== 'string')
            throw new RpcError('expect string marshalls id')
        if (typeof remote !== 'boolean')
            throw new RpcError('expect boolean marshalls remote')
        if (remote) {
            if (this.remotes.has_key(id))
                return this.remotes.get_value(id)!
            return this.new_remote(id)
        } else {
            const data = this.marshalls.get_value(id)
            if (data === null)
                throw new RpcError('unknown marshalled object')
            return data
        }
    }

    private serialize(data: Any): Ser {
        if (typeof data === 'symbol')
            return data.toString()
        if (typeof data === 'undefined')
            return null
        if (Array.isArray(data))
            return data.map(a => this.serialize(a))
        if (typeof data === 'object' && data !== null)
            return this.marshall(data)
        return data
    }

    private deserialize(ser: Json): Any {
        if (Array.isArray(ser))
            return ser.map(a => this.deserialize(a))
        if (typeof ser === 'object' && ser !== null)
            return this.unmarshall(ser)
        return ser
    }

    private new_remote(id: string): object {
        const remote = () => {}
        remote.id = id
        remote.rpc = this
        const data = new Proxy<Remote>(remote, this.remote_handler)
        this.remotes.add(id, data)
        return data
    }
}
