"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");

class Imow extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "imow",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.deviceArray = [];
        this.json2iob = new Json2iob(this);
        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create({
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                cookies: {
                    jar: this.cookieJar,
                },
            }),
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        if (!this.config.username || !this.config.password) {
            this.log.error("Please set username and password in the instance settings");
            return;
        }

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.session = {};
        this.subscribeStates("*");

        await this.login();

        if (this.session.access_token) {
            await this.getDeviceList();
            await this.updateDevices();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, 30 * 60 * 60 * 1000);
        }
    }
    async login() {
        const formField = await this.requestClient({
            method: "get",
            url: "https://oauth2.imow.stihl.com/authorization/?response_type=token&client_id=59714950-DD44-45E0-8A2F-6A93504A3C89&state=9185387873156676264&redirect_uri=stihl-imow-ios://",
            headers: {
                Host: "oauth2.imow.stihl.com",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "de",
            },
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return this.extractHidden(res.data);
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });

        if (!formField) {
            this.log.error("Missing form fields");
            return;
        }

        await this.requestClient({
            method: "post",
            url: "https://oauth2.imow.stihl.com/authentication/authenticate/?lang=de",
            headers: {
                Host: "oauth2.imow.stihl.com",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "content-type": "application/x-www-form-urlencoded",
                origin: "https://oauth2.imow.stihl.com",
                "accept-language": "de-de",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                referer:
                    "https://oauth2.imow.stihl.com/authentication/?authorizationRedirectUrl=https%3A%2F%2Foauth2.imow.stihl.com%2Fauthorization%2F%3Fresponse_type%3Dtoken%26client_id%3D59714950-DD44-45E0-8A2F-6A93504A3C89%26redirect_uri%3Dstihl-imow-ios%253A%252F%252F%26state%3D9185387873156676264",
            },
            data: qs.stringify({
                mail: this.config.username,
                password: this.config.password,
                "csrf-token": formField["csrf-token"],
                requestId: formField.requestId,
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.log.error(JSON.stringify(res.data));
            })
            .catch((error) => {
                if (error && error.message === "Unsupported protocol stihl-imow-ios:") {
                    this.session = qs.parse(error.request._options.path.split("?")[1]);
                    this.log.info("Login successful");
                    this.setState("info.connection", true, true);
                    return;
                }
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }
    extractHidden(body) {
        const returnObject = {};
        const matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
        for (const match of matches) {
            returnObject[match[1]] = match[2];
        }
        return returnObject;
    }
    async getDeviceList() {
        await this.requestClient({
            method: "get",
            url: "https://app-api-cmd-r-euwe-c8affb.azurewebsites.net/mowers/",
            headers: {
                accept: "*/*",
                "content-type": "application/json",
                "user-agent": "iMOW%C2%AE/3.0 CFNetwork/1240.0.4 Darwin/20.6.0",
                authorization: "Bearer " + this.session.access_token,
                "accept-language": "de-de",
            },
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));

                for (const device of res.data) {
                    const id = device.id;

                    this.deviceArray.push(id);
                    const name = device.name + " " + device.deviceTypeDescription;

                    await this.setObjectNotExistsAsync(id, {
                        type: "device",
                        common: {
                            name: name,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(id + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(id + ".json", {
                        type: "state",
                        common: {
                            name: "Raw JSON",
                            write: false,
                            read: true,
                            type: "string",
                            role: "json",
                        },
                        native: {},
                    });

                    const remoteArray = [
                        { command: "Refresh", name: "True = Refresh" },
                        { command: "toDocking", name: "True = toDocking" },
                        { command: "edgeMowing", name: "True = edgeMowing" },
                        { command: "startMowingFromPoint", name: "DurationInMunitesDividedBy10,StartPoint: Example: 9,0", type: "string", role: "text", def: "9,0" },
                    ];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(id + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                def: remote.def || false,
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.json2iob.parse(id, device);
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async updateDevices() {
        const statusArray = [
            {
                path: "",
                url: "https://app-api-cmd-r-euwe-c8affb.azurewebsites.net/mowers/$id/",
                desc: "Graph data of the device",
            },
        ];

        for (const id of this.deviceArray) {
            for (const element of statusArray) {
                const url = element.url.replace("$id", id);

                await this.requestClient({
                    method: element.method || "get",
                    url: url,
                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        "user-agent": "iMOW%C2%AE/3.0 CFNetwork/1240.0.4 Darwin/20.6.0",
                        authorization: "Bearer " + this.session.access_token,
                        "accept-language": "de-de",
                    },
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        const data = res.data;

                        const forceIndex = true;
                        const preferedArrayName = null;

                        this.setState(id + ".json", JSON.stringify(data), true);
                        this.json2iob.parse(id, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName, channelName: element.desc });
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshToken();
                                }, 1000 * 60);

                                return;
                            }
                        }
                        this.log.error(url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
    }
    async refreshToken() {
        if (!this.session) {
            this.log.error("No session found relogin");
            await this.login();
            return;
        }
        await this.login();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            this.refreshTimeout && clearTimeout(this.refreshTimeout);
            this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
            this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
            this.updateInterval && clearInterval(this.updateInterval);
            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                const command = id.split(".")[4];
                if (id.split(".")[3] !== "remote") {
                    return;
                }

                if (command === "Refresh") {
                    this.updateDevices();
                    return;
                }
                this.log.debug(deviceId);
                const externalIdState = await this.getStateAsync(deviceId + ".externalId");
                if (!externalIdState) {
                    this.log.error("Missing external id");
                    return;
                }
                const externalId = externalIdState.val;
                const data = {
                    actionValue: externalId,
                    actionName: command,
                };
                if (command === "startMowingFromPoint") {
                    data.actionValue = data.actionValue + "," + state.val;
                }
                this.log.debug(JSON.stringify(data));
                await this.requestClient({
                    method: "post",
                    url: "https://app-api-cmd-r-euwe-c8affb.azurewebsites.net/mower-actions/",
                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        authorization: "Bearer " + this.session.access_token,
                        "user-agent": "iMOW%C2%AE/3.0 CFNetwork/1240.0.4 Darwin/20.6.0",
                        "accept-language": "de-de",
                    },
                    data: JSON.stringify(data),
                })
                    .then((res) => {
                        this.log.info(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                    });
                clearTimeout(this.refreshTimeout);
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateDevices();
                }, 20 * 1000);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Imow(options);
} else {
    // otherwise start the instance directly
    new Imow();
}
