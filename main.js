"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const qs = require("qs");
const Json2iob = require("json2iob");
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
    this.etags = {};
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

    if (this.config.type === "myimow") {
      await this.loginMyImow();
    } else {
      await this.login();
    }

    if (this.session.access_token) {
      if (this.config.type === "myimow") {
        this.log.info("Login successful");
        await this.getDeviceListmyimow();
        await this.updateDevicesmyimow();
        /*TODO add signal websocket
        POST https://msg-signalr-app-mowcii-p.service.signalr.net/client/negotiate?hub=deviceevents
        WS https://msg-signalr-app-mowcii-p.service.signalr.net/client/?hub=deviceevents&id=  connectionId
        Ocp-Apim-Subscriptio and bearer
        send {"protocol": "json", "version": 1}.
        ping {"type":6}.
*/
        this.updateInterval = setInterval(async () => {
          await this.updateDevicesmyimow();
        }, this.config.interval * 60 * 1000);
      } else {
        await this.getDeviceList();
        await this.updateDevices();
        this.updateInterval = setInterval(async () => {
          await this.updateDevices();
        }, this.config.interval * 60 * 1000);
      }
      let expireTimeout = 30 * 60 * 60 * 1000;
      if (this.session.expires_in) {
        expireTimeout = this.session.expires_in;
      }
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, expireTimeout);
    }
  }
  async loginMyImow() {
    const settings = await this.requestClient({
      method: "get",
      url: "https://login.stihl.com/stihlidproduction.onmicrosoft.com/b2c_1a_production_flow_signin/oauth2/v2.0/authorize",
      params: {
        response_type: "code",
        code_challenge_method: "S256",
        scope: "offline_access https://login.stihl.com/scopes/profile openid",
        code_challenge: "tVL4sat5ICtwTzAYgTRY51yCElsZE3Y3NScIcBRFe5o",
        response_mode: "query",
        redirect_uri: "imow://www.imow.com/welcome/login",
        client_id: "0d947284-c186-454e-96fd-0094f4510b3f",
        state: "ACdOTeZS0KKrvWX8bPvhJ1WrncQUbvAJzpufx1swubg",
      },
    })
      .then((res) => {
        return JSON.parse(res.data.split("var SETTINGS = ")[1].split(";")[0]);
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    await this.requestClient({
      method: "post",

      url:
        "https://login.stihl.com/stihlidproduction.onmicrosoft.com/B2C_1A_production_Flow_SignIn/SelfAsserted?tx=" +
        settings.transId +
        "&p=B2C_1A_production_Flow_SignIn",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "x-csrf-token": settings.csrf,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      data: { request_type: "RESPONSE", signInName: this.config.username, password: this.config.password },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    const codereturn = await this.requestClient({
      method: "get",
      url: "https://login.stihl.com/stihlidproduction.onmicrosoft.com/B2C_1A_production_Flow_SignIn/api/CombinedSigninAndSignup/confirmed",
      params: {
        rememberMe: true,
        csrf_token: settings.csrf,
        tx: settings.transId,
        p: "B2C_1A_production_Flow_SignIn",
        diags:
          '{"pageViewId":"96f748fe-db20-469d-8e38-a4364a9c1679","pageId":"CombinedSigninAndSignup","trace":[{"ac":"T005","acST":1692792266,"acD":3},{"ac":"T021 - URL:https://app.stihl.com/static/login/production/de-DE.html","acST":1692792266,"acD":252},{"ac":"T019","acST":1692792266,"acD":13},{"ac":"T004","acST":1692792266,"acD":8},{"ac":"T003","acST":1692792266,"acD":0},{"ac":"T035","acST":1692792266,"acD":0},{"ac":"T030Online","acST":1692792266,"acD":0},{"ac":"T002","acST":1692792285,"acD":0},{"ac":"T018T010","acST":1692792284,"acD":742}]}',
      },
    })
      .then((res) => {
        this.log.error(JSON.stringify(res.data));
      })
      .catch((error) => {
        if (error && error.message.includes("Unsupported protocol")) {
          return qs.parse(error.request._options.path.split("?")[1]);
        }
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    await this.requestClient({
      method: "post",
      url: "https://login.stihl.com/stihlidproduction.onmicrosoft.com/b2c_1a_production_flow_signin/oauth2/v2.0/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      data: {
        code: codereturn.code,
        code_verifier: "vMkOO8V_7wUJnNMJY9e0QAQZyjhXDmOQvw_vWZgQZlo",
        redirect_uri: "imow://www.imow.com/welcome/login",
        client_id: "0d947284-c186-454e-96fd-0094f4510b3f",
        grant_type: "authorization_code",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState("info.connection", true, true);
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
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
        if (error && error.message.includes("Unsupported protocol")) {
          this.session = qs.parse(error.request._options.path.split("?")[1]);
          this.log.debug("Refresh successful");
          this.setState("info.connection", true, true);
          return "refresh";
        }
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });

    if (!formField) {
      this.log.error("Missing form fields");
      return;
    }
    if (formField === "refresh") {
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
        if (error && error.message.includes("Unsupported protocol")) {
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

  async getDeviceListmyimow() {
    await this.requestClient({
      method: "get",
      url: "https://apim.stihl.cloud/imow/p/mowertwin/api/v1/mowers",
      headers: {
        "Ocp-Apim-Subscription-Key": "52659909060946fc88f2d3368c16d9c7",
        accept: "*/*",
        authorization: "Bearer " + this.session.access_token,
        "accept-language": "de-de",
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        for (const device of res.data.mowers) {
          const id = device.deviceId;

          this.deviceArray.push(id);
          const name = device.nickname + " " + device.device.type;

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
            { command: "pause", name: "True = pause" },
            { command: "resume", name: "True = resume" },
            { command: "end-job-and-return-to-dock", name: "True = end-job-and-return-to-dock" },
            {
              command: "start-mowing",
              name: 'Json: Example: {"duradurationInSecondstion": 7200, "mowingZoneId": 0}',
              type: "string",
              role: "json",
              def: `{
                "durationInSeconds": 7200,
                "mowingZoneId": 0
            }`,
            },
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
            {
              command: "startMowingFromPoint",
              name: "DurationInMunitesDividedBy10,StartPoint: Example: 9,0",
              type: "string",
              role: "text",
              def: "9,0",
            },
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
  async updateDevicesmyimow() {
    const statusArray = [
      {
        path: "",
        url: "https://apim.stihl.cloud/imow/p/mowertwin/api/v1/dashboard-status/$id?force-status-update-mode=force",
        desc: "Status via Dashboard",
      },
    ];

    for (const id of this.deviceArray) {
      for (const element of statusArray) {
        const url = element.url.replace("$id", id);

        await this.requestClient({
          method: element.method || "get",
          url: url,
          headers: {
            "Ocp-Apim-Subscription-Key": "52659909060946fc88f2d3368c16d9c7",
            accept: "*/*",
            "If-None-Match": this.etags[id] || "",

            authorization: "Bearer " + this.session.access_token,
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data;
            this.etags[id] = res.headers.etag;

            const forceIndex = true;
            const preferedArrayName = null;

            this.setState(id + ".json", JSON.stringify(data), true);
            this.json2iob.parse(id, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName, channelName: element.desc });
          })
          .catch((error) => {
            if (error.status === 304) {
              return;
            }
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
            this.log.debug(url);
            this.log.info(error);
            error.response && this.log.info(JSON.stringify(error.response.data));
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
    if (this.config.type === "myimow") {
      await this.requestClient({
        method: "post",
        url: "https://login.stihl.com/stihlidproduction.onmicrosoft.com/b2c_1a_production_flow_signin/oauth2/v2.0/token",
        headers: {
          "ocp-apim-subscription-key": "52659909060946fc88f2d3368c16d9c7",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        data: {
          refresh_token: this.session.refresh_token,
          scope: "offline_access https://login.stihl.com/scopes/profile openid",
          client_id: "0d947284-c186-454e-96fd-0094f4510b3f",
          grant_type: "refresh_token",
        },
      })
        .then((res) => {
          this.log.debug(JSON.stringify(res.data));
          this.session = res.data;
          this.setState("info.connection", true, true);
        })
        .catch((error) => {
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    } else {
      await this.login();
    }
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
          if (this.config.type === "myimow") {
            this.updateDevicesmyimow();
            return;
          } else {
            this.updateDevices();
            return;
          }
        }
        this.log.debug(deviceId);
        if (this.config.type === "myimow") {
          let data = {};
          if (command === "start-mowing") {
            data = state.val;
          }

          this.requestClient({
            method: "post",

            url: "https://apim.stihl.cloud/imow/p/mowerctrl/api/v1/mower-commands/" + deviceId + "/" + command,
            headers: {
              "Ocp-Apim-Subscription-Key": "52659909060946fc88f2d3368c16d9c7",
              "Content-Type": "application/json",
              accept: "*/*",
              authorization: "Bearer " + this.session.access_token,
            },
            data: data,
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
        } else {
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
        }
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          if (this.config.type === "myimow") {
            await this.updateDevicesmyimow();
          } else {
            await this.updateDevices();
          }
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
