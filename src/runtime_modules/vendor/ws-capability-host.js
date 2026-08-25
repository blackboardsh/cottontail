import EventEmitter from "node:events";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import * as http from "node:http";

cottontail.__cottontailWebSocketHostModules ??= { EventEmitter, Buffer, Duplex, http };
