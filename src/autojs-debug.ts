import { EventEmitter } from 'events';
import * as ws from 'websocket';
import * as http from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import * as fs from 'fs'
import { Project, ProjectObserser } from './project';
import * as vscode from "vscode";

const DEBUG = false;

function logDebug(message?: any, ...optionalParams: any[]) {
    if (DEBUG) {
        console.log.apply(console, arguments);
    }
}


const HANDSHAKE_TIMEOUT = 10 * 1000;

export class Device extends EventEmitter {
    public name: string;
    private connection: ws.connection;
    private attached: boolean = false;
    public projectObserser: ProjectObserser;

    constructor(connection: ws.connection) {
        super();
        this.connection = connection;
        this.read(this.connection);
        this.on('data:hello', data => {
            logDebug("on client hello: ", data);
            this.attached = true;
            this.name = data['device_name'];
            this.send("hello", {
                "server_version": 2
            });
            this.emit("attach", this);
        });
        setTimeout(() => {
            if (!this.attached) {
                console.log("handshake timeout");
                this.connection.close();
                this.connection = null;
            }
        }, HANDSHAKE_TIMEOUT);
    }

    send(type: string, data: any): void {
        let   message_id = `${Date.now()}_${Math.random()}`;
        console.log(data);
        this.connection.sendUTF(JSON.stringify({
            type: type,
            message_id,
            data: data
        }));
    }

    sendBytes(bytes: Buffer): void {
        this.connection.sendBytes(bytes);
    }

    sendBytesCommand(command: string, md5: string, data: object = {}): void {
        data = Object(data);
        data['command'] = command; 
        let   message_id = `${Date.now()}_${Math.random()}`;
        this.connection.sendUTF(JSON.stringify({
            type: 'bytes_command',
            message_id,
            md5: md5,
            data: data
        }));
    }

    sendCommand(command: string, data: object): void {
        data = Object(data);
        data['command'] = command;
        this.send('command', data);
    }

    public toString = (): string => {
        if (!this.connection) {
            return `${this.name}[Disconnected]`
        }
        if (!this.name) {
            return `Device (${this.connection.remoteAddress})`;
        }
        return `Device ${this.name}(${this.connection.remoteAddress})`;
    }

    private read(connection: ws.connection) {
        connection.on('message', message => {
            logDebug("message: ", message);
            if (message.type == 'utf8') {
                try {
                    let json = JSON.parse(message.utf8Data);
                    if(json.type=="hello"){
                        logDebug("返回消息")
                     let message_id = `${Date.now()}_${Math.random()}`;
                      this.connection.sendUTF(JSON.stringify( {message_id,  data:"连接成功",debug:true, type: 'hello' }));
                    }
                    logDebug("json: ", json);
                    this.emit('message', json);
                    this.emit('data:' + json['type'], json['data']);
                } catch (e) {
                    console.error(e);
                }
            }
        });
        connection.on('close', (reasonCode, description) => {
            console.log(`close: device = ${this}, reason = ${reasonCode}, desc = ${description}`);
            this.connection = null;
            this.emit('disconnect');
        });
    }

}

export class AutoJsDebugServer extends EventEmitter {
    private httpServer: http.Server;
    private port: number;
    public devices: Array<Device> = [];
    public project: Project = null;
    private logChannels: Map<string, vscode.OutputChannel>;
    private fileFilter = (relativePath: string, absPath: string, stats: fs.Stats) => {
        if (!this.project) {
            return true;
        }
        return this.project.fileFilter(relativePath, absPath, stats);
    };

    constructor(port: number) {
        super();
        this.logChannels = new Map<string, vscode.OutputChannel>();
        this.port = port;
        this.httpServer = http.createServer((request, response) => {
            console.log(new Date() + ' Received request for ' + request.url);
            var urlObj = url.parse(request.url);
            var query = urlObj.query;
            var queryObj = querystring.parse(query);
            if (urlObj.pathname == "/exec") {
                response.writeHead(200);
                response.end("this commond is:" +queryObj.cmd+"-->"+ queryObj.path);
                this.emit('cmd', queryObj.cmd,queryObj.path);
                console.log(queryObj.cmd,queryObj.path);
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        var wsServer = new ws.server({ httpServer: this.httpServer });
        wsServer.on('request', request => {
            let connection = this.openConnection(request);
            if (!connection) {
                return;
            }
            let device = new Device(connection);
            logDebug(connection.state,"--->status")
            device.on("attach", (device) => {
                this.attachDevice(device);
                this.emit('new_device', device);
                let logChannel = this.newLogChannel(device);
                logChannel.appendLine(`设备已连接：${device}`);
            });
        })
    }
    openConnection(request: ws.request): ws.connection {
        return request.accept();
    }

    listen(): void {
        this.httpServer.on('error', (e) => {
            console.error('server error: ', e);
        });
        this.httpServer.listen(this.port, '0.0.0.0', () => {
            let address = this.httpServer.address();
            var localAddress = this.getIPAddress();
            console.log(`server listening on ${localAddress}:${address.port} / ${address.address}:${address.port}`);
            this.emit("connect");
        });
    }

    send(type: string, data: any): void {
        this.devices.forEach(device => {
            device.send(type, data);
        });
    }

    sendBytes(data: Buffer): void {
        this.devices.forEach(device => {
            device.sendBytes(data);
        });
    }

    sendBytesCommand(command: string, md5: string, data: object = {}): void {
        this.devices.forEach(device => {
            device.sendBytesCommand(command, md5, data);
        });
    }

    sendProjectCommand(folder: string, command: string) {
        let startTime = new Date().getTime();
        this.devices.forEach(device => {
            if (device.projectObserser == null || device.projectObserser.folder != folder) {
                device.projectObserser = new ProjectObserser(folder, this.fileFilter);
            }
            device.projectObserser.diff()
                .then(result => {
                    device.sendBytes(result.buffer);
                    device.sendBytesCommand(command, result.md5, {
                        'id': folder,
                        'name': folder
                    });
                    this.getLogChannel(device).appendLine(`发送项目耗时: ${(new Date().getTime() - startTime) / 1000} 秒`);
                });
        });
    }

    sendCommand(command: string, data: object = {}): void {
        this.devices.forEach(device => {
            device.sendCommand(command, data);
        });
    }

    disconnect(): void {
        this.httpServer.close();
        this.emit("disconnect");
        this.logChannels.forEach(channel => {
            channel.dispose();
        });
        this.logChannels.clear();
    }

    /** 获取本地IP */
    getIPAddress(): string {
        var interfaces = require('os').networkInterfaces();
        for (var devName in interfaces) {
            var iface = interfaces[devName];
            for (var i = 0; i < iface.length; i++) {
                var alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                    return alias.address;
                }
            }
        }
    }

    /** 获取服务运行端口 */
    getPort(): number {
        return this.port;
    }

    private attachDevice(device: Device): void {
        this.devices.push(device);
        device.on('data:log', data => {
            console.log(data['log']);
            this.getLogChannel(device).appendLine(data['log']);
            this.emit('log', data['log']);
        });
        device.on('disconnect', this.detachDevice.bind(this, device));
    }

    private detachDevice(device: Device): void {
        this.devices.splice(this.devices.indexOf(device), 1);
        console.log("detachDevice: " + device);
        this.getLogChannel(device).appendLine(`设备已断开：${device}`);
    }

    /** 创建设备日志打印通道 */
    private newLogChannel(device: Device): vscode.OutputChannel {
        let channelName = `${device}`;
        let logChannel = this.logChannels.get(channelName);
        if (!logChannel) {
            logChannel = vscode.window.createOutputChannel(channelName);
            this.logChannels.set(channelName, logChannel);
        }
        logChannel.show(true);
        // console.log("创建日志通道" + channelName)
        return logChannel;
    }

    /** 获取设备日志打印通道 */
    private getLogChannel(device: Device): vscode.OutputChannel {
        let channelName = `${device}`;
        // console.log("获取日志通道：" + channelName);
        return this.logChannels.get(channelName);
    }

}
