'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var _ = require('lodash');
var ___default = _interopDefault(_);
var fs = _interopDefault(require('fs'));
var iconv = _interopDefault(require('iconv-lite'));
var ubjson = require('@shelacek/ubjson');
var semver = _interopDefault(require('semver'));
var events = require('events');
var moment = _interopDefault(require('moment'));
var stream = require('stream');
var net = _interopDefault(require('net'));
var inject = _interopDefault(require('reconnect-core'));
var path = _interopDefault(require('path'));

function toHalfwidth(str) {
    // Code reference from https://github.com/sampathsris/ascii-fullwidth-halfwidth-convert
    // Converts a fullwidth character to halfwidth
    var convertChar = function (charCode) {
        if (charCode > 0xff00 && charCode < 0xff5f) {
            return 0x0020 + (charCode - 0xff00);
        }
        if (charCode === 0x3000) {
            return 0x0020;
        }
        return charCode;
    };
    var ret = ___default.map(str, function (char) { return convertChar(char.charCodeAt(0)); });
    return String.fromCharCode.apply(String, ret);
}

(function (Command) {
    Command[Command["MESSAGE_SIZES"] = 53] = "MESSAGE_SIZES";
    Command[Command["GAME_START"] = 54] = "GAME_START";
    Command[Command["PRE_FRAME_UPDATE"] = 55] = "PRE_FRAME_UPDATE";
    Command[Command["POST_FRAME_UPDATE"] = 56] = "POST_FRAME_UPDATE";
    Command[Command["GAME_END"] = 57] = "GAME_END";
    Command[Command["ITEM_UPDATE"] = 59] = "ITEM_UPDATE";
    Command[Command["FRAME_BOOKEND"] = 60] = "FRAME_BOOKEND";
})(exports.Command || (exports.Command = {}));
(function (GameMode) {
    GameMode[GameMode["VS"] = 2] = "VS";
    GameMode[GameMode["ONLINE"] = 8] = "ONLINE";
})(exports.GameMode || (exports.GameMode = {}));
(function (Frames) {
    Frames[Frames["FIRST"] = -123] = "FIRST";
    Frames[Frames["FIRST_PLAYABLE"] = -39] = "FIRST_PLAYABLE";
})(exports.Frames || (exports.Frames = {}));

var SlpInputSource;
(function (SlpInputSource) {
    SlpInputSource["BUFFER"] = "buffer";
    SlpInputSource["FILE"] = "file";
})(SlpInputSource || (SlpInputSource = {}));
function getRef(input) {
    switch (input.source) {
        case SlpInputSource.FILE:
            var fd = fs.openSync(input.filePath, "r");
            return {
                source: input.source,
                fileDescriptor: fd,
            };
        case SlpInputSource.BUFFER:
            return {
                source: input.source,
                buffer: input.buffer,
            };
        default:
            throw new Error("Source type not supported");
    }
}
function readRef(ref, buffer, offset, length, position) {
    switch (ref.source) {
        case SlpInputSource.FILE:
            return fs.readSync(ref.fileDescriptor, buffer, offset, length, position);
        case SlpInputSource.BUFFER:
            return ref.buffer.copy(buffer, offset, position, position + length);
        default:
            throw new Error("Source type not supported");
    }
}
function getLenRef(ref) {
    switch (ref.source) {
        case SlpInputSource.FILE:
            var fileStats = fs.fstatSync(ref.fileDescriptor);
            return fileStats.size;
        case SlpInputSource.BUFFER:
            return ref.buffer.length;
        default:
            throw new Error("Source type not supported");
    }
}
/**
 * Opens a file at path
 */
function openSlpFile(input) {
    var ref = getRef(input);
    var rawDataPosition = getRawDataPosition(ref);
    var rawDataLength = getRawDataLength(ref, rawDataPosition);
    var metadataPosition = rawDataPosition + rawDataLength + 10; // remove metadata string
    var metadataLength = getMetadataLength(ref, metadataPosition);
    var messageSizes = getMessageSizes(ref, rawDataPosition);
    return {
        ref: ref,
        rawDataPosition: rawDataPosition,
        rawDataLength: rawDataLength,
        metadataPosition: metadataPosition,
        metadataLength: metadataLength,
        messageSizes: messageSizes,
    };
}
function closeSlpFile(file) {
    switch (file.ref.source) {
        case SlpInputSource.FILE:
            fs.closeSync(file.ref.fileDescriptor);
            break;
    }
}
// This function gets the position where the raw data starts
function getRawDataPosition(ref) {
    var buffer = new Uint8Array(1);
    readRef(ref, buffer, 0, buffer.length, 0);
    if (buffer[0] === 0x36) {
        return 0;
    }
    if (buffer[0] !== "{".charCodeAt(0)) {
        return 0; // return error?
    }
    return 15;
}
function getRawDataLength(ref, position) {
    var fileSize = getLenRef(ref);
    if (position === 0) {
        return fileSize;
    }
    var buffer = new Uint8Array(4);
    readRef(ref, buffer, 0, buffer.length, position - 4);
    var rawDataLen = (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
    if (rawDataLen > 0) {
        // If this method manages to read a number, it's probably trustworthy
        return rawDataLen;
    }
    // If the above does not return a valid data length,
    // return a file size based on file length. This enables
    // some support for severed files
    return fileSize - position;
}
function getMetadataLength(ref, position) {
    var len = getLenRef(ref);
    return len - position - 1;
}
function getMessageSizes(ref, position) {
    var messageSizes = {};
    // Support old file format
    if (position === 0) {
        messageSizes[0x36] = 0x140;
        messageSizes[0x37] = 0x6;
        messageSizes[0x38] = 0x46;
        messageSizes[0x39] = 0x1;
        return messageSizes;
    }
    var buffer = new Uint8Array(2);
    readRef(ref, buffer, 0, buffer.length, position);
    if (buffer[0] !== exports.Command.MESSAGE_SIZES) {
        return {};
    }
    var payloadLength = buffer[1];
    messageSizes[0x35] = payloadLength;
    var messageSizesBuffer = new Uint8Array(payloadLength - 1);
    readRef(ref, messageSizesBuffer, 0, messageSizesBuffer.length, position + 2);
    for (var i = 0; i < payloadLength - 1; i += 3) {
        var command = messageSizesBuffer[i];
        // Get size of command
        messageSizes[command] = (messageSizesBuffer[i + 1] << 8) | messageSizesBuffer[i + 2];
    }
    return messageSizes;
}
/**
 * Iterates through slp events and parses payloads
 */
function iterateEvents(slpFile, callback, startPos) {
    if (startPos === void 0) { startPos = null; }
    var ref = slpFile.ref;
    var readPosition = startPos || slpFile.rawDataPosition;
    var stopReadingAt = slpFile.rawDataPosition + slpFile.rawDataLength;
    // Generate read buffers for each
    var commandPayloadBuffers = ___default.mapValues(slpFile.messageSizes, function (size) { return new Uint8Array(size + 1); });
    var commandByteBuffer = new Uint8Array(1);
    while (readPosition < stopReadingAt) {
        readRef(ref, commandByteBuffer, 0, 1, readPosition);
        var commandByte = commandByteBuffer[0];
        var buffer = commandPayloadBuffers[commandByte];
        if (buffer === undefined) {
            // If we don't have an entry for this command, return false to indicate failed read
            return readPosition;
        }
        if (buffer.length > stopReadingAt - readPosition) {
            return readPosition;
        }
        readRef(ref, buffer, 0, buffer.length, readPosition);
        var parsedPayload = parseMessage(commandByte, buffer);
        var shouldStop = callback(commandByte, parsedPayload);
        if (shouldStop) {
            break;
        }
        readPosition += buffer.length;
    }
    return readPosition;
}
function parseMessage(command, payload) {
    var view = new DataView(payload.buffer);
    switch (command) {
        case exports.Command.GAME_START:
            var getPlayerObject = function (playerIndex) {
                // Controller Fix stuff
                var cfOffset = playerIndex * 0x8;
                var dashback = readUint32(view, 0x141 + cfOffset);
                var shieldDrop = readUint32(view, 0x145 + cfOffset);
                var cfOption = "None";
                if (dashback !== shieldDrop) {
                    cfOption = "Mixed";
                }
                else if (dashback === 1) {
                    cfOption = "UCF";
                }
                else if (dashback === 2) {
                    cfOption = "Dween";
                }
                // Nametag stuff
                var nametagOffset = playerIndex * 0x10;
                var nametagStart = 0x161 + nametagOffset;
                var nametagBuf = payload.slice(nametagStart, nametagStart + 16);
                var nametag = toHalfwidth(iconv
                    .decode(nametagBuf, "Shift_JIS")
                    .split("\0")
                    .shift());
                var offset = playerIndex * 0x24;
                return {
                    playerIndex: playerIndex,
                    port: playerIndex + 1,
                    characterId: readUint8(view, 0x65 + offset),
                    characterColor: readUint8(view, 0x68 + offset),
                    startStocks: readUint8(view, 0x67 + offset),
                    type: readUint8(view, 0x66 + offset),
                    teamId: readUint8(view, 0x6e + offset),
                    controllerFix: cfOption,
                    nametag: nametag,
                };
            };
            return {
                slpVersion: readUint8(view, 0x1) + "." + readUint8(view, 0x2) + "." + readUint8(view, 0x3),
                isTeams: readBool(view, 0xd),
                isPAL: readBool(view, 0x1a1),
                stageId: readUint16(view, 0x13),
                players: [0, 1, 2, 3].map(getPlayerObject),
                scene: readUint8(view, 0x1a3),
                gameMode: readUint8(view, 0x1a4),
            };
        case exports.Command.PRE_FRAME_UPDATE:
            return {
                frame: readInt32(view, 0x1),
                playerIndex: readUint8(view, 0x5),
                isFollower: readBool(view, 0x6),
                seed: readUint32(view, 0x7),
                actionStateId: readUint16(view, 0xb),
                positionX: readFloat(view, 0xd),
                positionY: readFloat(view, 0x11),
                facingDirection: readFloat(view, 0x15),
                joystickX: readFloat(view, 0x19),
                joystickY: readFloat(view, 0x1d),
                cStickX: readFloat(view, 0x21),
                cStickY: readFloat(view, 0x25),
                trigger: readFloat(view, 0x29),
                buttons: readUint32(view, 0x2d),
                physicalButtons: readUint16(view, 0x31),
                physicalLTrigger: readFloat(view, 0x33),
                physicalRTrigger: readFloat(view, 0x37),
                percent: readFloat(view, 0x3c),
            };
        case exports.Command.POST_FRAME_UPDATE:
            return {
                frame: readInt32(view, 0x1),
                playerIndex: readUint8(view, 0x5),
                isFollower: readBool(view, 0x6),
                internalCharacterId: readUint8(view, 0x7),
                actionStateId: readUint16(view, 0x8),
                positionX: readFloat(view, 0xa),
                positionY: readFloat(view, 0xe),
                facingDirection: readFloat(view, 0x12),
                percent: readFloat(view, 0x16),
                shieldSize: readFloat(view, 0x1a),
                lastAttackLanded: readUint8(view, 0x1e),
                currentComboCount: readUint8(view, 0x1f),
                lastHitBy: readUint8(view, 0x20),
                stocksRemaining: readUint8(view, 0x21),
                actionStateCounter: readFloat(view, 0x22),
                lCancelStatus: readUint8(view, 0x33),
            };
        case exports.Command.ITEM_UPDATE:
            return {
                frame: readInt32(view, 0x1),
                typeId: readUint16(view, 0x5),
                state: readUint8(view, 0x7),
                facingDirection: readFloat(view, 0x8),
                velocityX: readFloat(view, 0xc),
                velocityY: readFloat(view, 0x10),
                positionX: readFloat(view, 0x14),
                positionY: readFloat(view, 0x18),
                damageTaken: readUint16(view, 0x1c),
                expirationTimer: readUint16(view, 0x1e),
                spawnId: readUint32(view, 0x20),
            };
        case exports.Command.FRAME_BOOKEND:
            return {
                frame: readInt32(view, 0x1),
                latestFinalizedFrame: readInt32(view, 0x5),
            };
        case exports.Command.GAME_END:
            return {
                gameEndMethod: readUint8(view, 0x1),
                lrasInitiatorIndex: readInt8(view, 0x2),
            };
        default:
            return null;
    }
}
function canReadFromView(view, offset, length) {
    var viewLength = view.byteLength;
    return offset + length <= viewLength;
}
function readFloat(view, offset) {
    if (!canReadFromView(view, offset, 4)) {
        return null;
    }
    return view.getFloat32(offset);
}
function readInt32(view, offset) {
    if (!canReadFromView(view, offset, 4)) {
        return null;
    }
    return view.getInt32(offset);
}
function readInt8(view, offset) {
    if (!canReadFromView(view, offset, 1)) {
        return null;
    }
    return view.getInt8(offset);
}
function readUint32(view, offset) {
    if (!canReadFromView(view, offset, 4)) {
        return null;
    }
    return view.getUint32(offset);
}
function readUint16(view, offset) {
    if (!canReadFromView(view, offset, 2)) {
        return null;
    }
    return view.getUint16(offset);
}
function readUint8(view, offset) {
    if (!canReadFromView(view, offset, 1)) {
        return null;
    }
    return view.getUint8(offset);
}
function readBool(view, offset) {
    if (!canReadFromView(view, offset, 1)) {
        return null;
    }
    return !!view.getUint8(offset);
}
function getMetadata(slpFile) {
    if (slpFile.metadataLength <= 0) {
        // This will happen on a severed incomplete file
        // $FlowFixMe
        return null;
    }
    var buffer = new Uint8Array(slpFile.metadataLength);
    readRef(slpFile.ref, buffer, 0, buffer.length, slpFile.metadataPosition);
    var metadata = null;
    try {
        metadata = ubjson.decode(buffer);
    }
    catch (ex) {
        // Do nothing
        // console.log(ex);
    }
    // $FlowFixMe
    return metadata;
}

/*! *****************************************************************************
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0

THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
MERCHANTABLITY OR NON-INFRINGEMENT.

See the Apache Version 2.0 License for specific language governing permissions
and limitations under the License.
***************************************************************************** */
/* global Reflect, Promise */

var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return extendStatics(d, b);
};

function __extends(d, b) {
    extendStatics(d, b);
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

var __assign = function() {
    __assign = Object.assign || function __assign(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};

var MAX_ROLLBACK_FRAMES = 7;
(function (SlpParserEvent) {
    SlpParserEvent["SETTINGS"] = "settings";
    SlpParserEvent["END"] = "end";
    SlpParserEvent["FRAME"] = "frame";
    SlpParserEvent["FINALIZED_FRAME"] = "finalized-frame";
})(exports.SlpParserEvent || (exports.SlpParserEvent = {}));
// If strict mode is on, we will do strict validation checking
// which could throw errors on invalid data.
// Default to false though since probably only real time applications
// would care about valid data.
var defaultSlpParserOptions = {
    strict: false,
};
var SlpParser = /** @class */ (function (_super) {
    __extends(SlpParser, _super);
    function SlpParser(options) {
        var _this = _super.call(this) || this;
        _this.frames = {};
        _this.settings = null;
        _this.gameEnd = null;
        _this.latestFrameIndex = null;
        _this.settingsComplete = false;
        _this.lastFinalizedFrame = exports.Frames.FIRST - 1;
        _this.options = Object.assign({}, defaultSlpParserOptions, options);
        return _this;
    }
    SlpParser.prototype.handleCommand = function (command, payload) {
        switch (command) {
            case exports.Command.GAME_START:
                this._handleGameStart(payload);
                break;
            case exports.Command.POST_FRAME_UPDATE:
                // We need to handle the post frame update first since that
                // will finalize the settings object, before we fire the frame update
                this._handlePostFrameUpdate(payload);
                this._handleFrameUpdate(command, payload);
                break;
            case exports.Command.PRE_FRAME_UPDATE:
                this._handleFrameUpdate(command, payload);
                break;
            case exports.Command.ITEM_UPDATE:
                this._handleItemUpdate(payload);
                break;
            case exports.Command.FRAME_BOOKEND:
                this._handleFrameBookend(payload);
                break;
            case exports.Command.GAME_END:
                this._handleGameEnd(payload);
                break;
        }
    };
    /**
     * Resets the parser state to their default values.
     */
    SlpParser.prototype.reset = function () {
        this.frames = {};
        this.settings = null;
        this.gameEnd = null;
        this.latestFrameIndex = null;
        this.settingsComplete = false;
        this.lastFinalizedFrame = exports.Frames.FIRST - 1;
    };
    SlpParser.prototype.getLatestFrameNumber = function () {
        return this.latestFrameIndex;
    };
    SlpParser.prototype.getPlayableFrameCount = function () {
        return this.latestFrameIndex < exports.Frames.FIRST_PLAYABLE ? 0 : this.latestFrameIndex - exports.Frames.FIRST_PLAYABLE;
    };
    SlpParser.prototype.getLatestFrame = function () {
        // return this.playerFrames[this.latestFrameIndex];
        // TODO: Modify this to check if we actually have all the latest frame data and return that
        // TODO: If we do. For now I'm just going to take a shortcut
        var allFrames = this.getFrames();
        var frameIndex = this.latestFrameIndex || exports.Frames.FIRST;
        var indexToUse = this.gameEnd ? frameIndex : frameIndex - 1;
        return ___default.get(allFrames, indexToUse) || null;
    };
    SlpParser.prototype.getSettings = function () {
        return this.settingsComplete ? this.settings : null;
    };
    SlpParser.prototype.getGameEnd = function () {
        return this.gameEnd;
    };
    SlpParser.prototype.getFrames = function () {
        return this.frames;
    };
    SlpParser.prototype.getFrame = function (num) {
        return this.frames[num] || null;
    };
    SlpParser.prototype._handleGameEnd = function (payload) {
        // Finalize remaining frames if necessary
        if (this.latestFrameIndex !== this.lastFinalizedFrame) {
            this._finalizeFrames(this.latestFrameIndex);
        }
        payload = payload;
        this.gameEnd = payload;
        this.emit(exports.SlpParserEvent.END, this.gameEnd);
    };
    SlpParser.prototype._handleGameStart = function (payload) {
        this.settings = payload;
        var players = payload.players;
        this.settings.players = players.filter(function (player) { return player.type !== 3; });
        // Check to see if the file was created after the sheik fix so we know
        // we don't have to process the first frame of the game for the full settings
        if (semver.gte(payload.slpVersion, "1.6.0")) {
            this._completeSettings();
        }
    };
    SlpParser.prototype._handlePostFrameUpdate = function (payload) {
        if (this.settingsComplete) {
            return;
        }
        // Finish calculating settings
        if (payload.frame <= exports.Frames.FIRST) {
            var playerIndex = payload.playerIndex;
            var playersByIndex = ___default.keyBy(this.settings.players, "playerIndex");
            switch (payload.internalCharacterId) {
                case 0x7:
                    playersByIndex[playerIndex].characterId = 0x13; // Sheik
                    break;
                case 0x13:
                    playersByIndex[playerIndex].characterId = 0x12; // Zelda
                    break;
            }
        }
        if (payload.frame > exports.Frames.FIRST) {
            this._completeSettings();
        }
    };
    SlpParser.prototype._handleFrameUpdate = function (command, payload) {
        payload = payload;
        var location = command === exports.Command.PRE_FRAME_UPDATE ? "pre" : "post";
        var field = payload.isFollower ? "followers" : "players";
        this.latestFrameIndex = payload.frame;
        ___default.set(this.frames, [payload.frame, field, payload.playerIndex, location], payload);
        ___default.set(this.frames, [payload.frame, "frame"], payload.frame);
        // If file is from before frame bookending, add frame to stats computer here. Does a little
        // more processing than necessary, but it works
        var settings = this.getSettings();
        if (!settings || semver.lte(settings.slpVersion, "2.2.0")) {
            this.emit(exports.SlpParserEvent.FRAME, this.frames[payload.frame]);
            // Finalize the previous frame since no bookending exists
            this._finalizeFrames(payload.frame - 1);
        }
        else {
            ___default.set(this.frames, [payload.frame, "isTransferComplete"], false);
        }
    };
    SlpParser.prototype._handleItemUpdate = function (payload) {
        var items = ___default.get(this.frames, [payload.frame, "items"], []);
        items.push(payload);
        // Set items with newest
        ___default.set(this.frames, [payload.frame, "items"], items);
    };
    SlpParser.prototype._handleFrameBookend = function (payload) {
        var frame = payload.frame, latestFinalizedFrame = payload.latestFinalizedFrame;
        ___default.set(this.frames, [frame, "isTransferComplete"], true);
        // Fire off a normal frame event
        this.emit(exports.SlpParserEvent.FRAME, this.frames[frame]);
        // Finalize frames if necessary
        var validLatestFrame = this.settings.gameMode === exports.GameMode.ONLINE;
        if (validLatestFrame && latestFinalizedFrame >= exports.Frames.FIRST) {
            // Ensure valid latestFinalizedFrame
            if (this.options.strict && latestFinalizedFrame < frame - MAX_ROLLBACK_FRAMES) {
                throw new Error("latestFinalizedFrame should be within " + MAX_ROLLBACK_FRAMES + " frames of " + frame);
            }
            this._finalizeFrames(latestFinalizedFrame);
        }
        else {
            // Since we don't have a valid finalized frame, just finalize the frame based on MAX_ROLLBACK_FRAMES
            this._finalizeFrames(payload.frame - MAX_ROLLBACK_FRAMES);
        }
    };
    /**
     * Fires off the FINALIZED_FRAME event for frames up until a certain number
     * @param num The frame to finalize until
     */
    SlpParser.prototype._finalizeFrames = function (num) {
        while (this.lastFinalizedFrame < num) {
            var frameToFinalize = this.lastFinalizedFrame + 1;
            var frame = this.getFrame(frameToFinalize);
            // Check that we have all the pre and post frame data for all players if we're in strict mode
            if (this.options.strict) {
                for (var _i = 0, _a = this.settings.players; _i < _a.length; _i++) {
                    var player = _a[_i];
                    var playerFrameInfo = frame.players[player.playerIndex];
                    // Allow player frame info to be empty in non 1v1 games since
                    // players which have been defeated will have no frame info.
                    if (this.settings.players.length > 2 && !playerFrameInfo) {
                        continue;
                    }
                    var pre = playerFrameInfo.pre, post = playerFrameInfo.post;
                    if (!pre || !post) {
                        var preOrPost = pre ? "pre" : "post";
                        throw new Error("Could not finalize frame " + frameToFinalize + " of " + num + ": missing " + preOrPost + "-frame update for player " + player.playerIndex);
                    }
                }
            }
            // Our frame is complete so finalize the frame
            this.emit(exports.SlpParserEvent.FINALIZED_FRAME, frame);
            this.lastFinalizedFrame = frameToFinalize;
        }
    };
    SlpParser.prototype._completeSettings = function () {
        if (!this.settingsComplete) {
            this.settingsComplete = true;
            this.emit(exports.SlpParserEvent.SETTINGS, this.settings);
        }
    };
    return SlpParser;
}(events.EventEmitter));

(function (State) {
    // Animation ID ranges
    State[State["DAMAGE_START"] = 75] = "DAMAGE_START";
    State[State["DAMAGE_END"] = 91] = "DAMAGE_END";
    State[State["CAPTURE_START"] = 223] = "CAPTURE_START";
    State[State["CAPTURE_END"] = 232] = "CAPTURE_END";
    State[State["GUARD_START"] = 178] = "GUARD_START";
    State[State["GUARD_END"] = 182] = "GUARD_END";
    State[State["GROUNDED_CONTROL_START"] = 14] = "GROUNDED_CONTROL_START";
    State[State["GROUNDED_CONTROL_END"] = 24] = "GROUNDED_CONTROL_END";
    State[State["SQUAT_START"] = 39] = "SQUAT_START";
    State[State["SQUAT_END"] = 41] = "SQUAT_END";
    State[State["DOWN_START"] = 183] = "DOWN_START";
    State[State["DOWN_END"] = 198] = "DOWN_END";
    State[State["TECH_START"] = 199] = "TECH_START";
    State[State["TECH_END"] = 204] = "TECH_END";
    State[State["DYING_START"] = 0] = "DYING_START";
    State[State["DYING_END"] = 10] = "DYING_END";
    State[State["CONTROLLED_JUMP_START"] = 24] = "CONTROLLED_JUMP_START";
    State[State["CONTROLLED_JUMP_END"] = 34] = "CONTROLLED_JUMP_END";
    State[State["GROUND_ATTACK_START"] = 44] = "GROUND_ATTACK_START";
    State[State["GROUND_ATTACK_END"] = 64] = "GROUND_ATTACK_END";
    // Animation ID specific
    State[State["ROLL_FORWARD"] = 233] = "ROLL_FORWARD";
    State[State["ROLL_BACKWARD"] = 234] = "ROLL_BACKWARD";
    State[State["SPOT_DODGE"] = 235] = "SPOT_DODGE";
    State[State["AIR_DODGE"] = 236] = "AIR_DODGE";
    State[State["ACTION_WAIT"] = 14] = "ACTION_WAIT";
    State[State["ACTION_DASH"] = 20] = "ACTION_DASH";
    State[State["ACTION_KNEE_BEND"] = 24] = "ACTION_KNEE_BEND";
    State[State["GUARD_ON"] = 178] = "GUARD_ON";
    State[State["TECH_MISS_UP"] = 183] = "TECH_MISS_UP";
    State[State["TECH_MISS_DOWN"] = 191] = "TECH_MISS_DOWN";
    State[State["DASH"] = 20] = "DASH";
    State[State["TURN"] = 18] = "TURN";
    State[State["LANDING_FALL_SPECIAL"] = 43] = "LANDING_FALL_SPECIAL";
    State[State["JUMP_FORWARD"] = 25] = "JUMP_FORWARD";
    State[State["JUMP_BACKWARD"] = 26] = "JUMP_BACKWARD";
    State[State["FALL_FORWARD"] = 30] = "FALL_FORWARD";
    State[State["FALL_BACKWARD"] = 31] = "FALL_BACKWARD";
    State[State["GRAB"] = 212] = "GRAB";
    State[State["CLIFF_CATCH"] = 252] = "CLIFF_CATCH";
})(exports.State || (exports.State = {}));
var Timers = {
    PUNISH_RESET_FRAMES: 45,
    RECOVERY_RESET_FRAMES: 45,
    COMBO_STRING_RESET_FRAMES: 45,
};
function getSinglesPlayerPermutationsFromSettings(settings) {
    if (!settings || settings.players.length !== 2) {
        // Only return opponent indices for singles
        return [];
    }
    return [
        {
            playerIndex: settings.players[0].playerIndex,
            opponentIndex: settings.players[1].playerIndex,
        },
        {
            playerIndex: settings.players[1].playerIndex,
            opponentIndex: settings.players[0].playerIndex,
        },
    ];
}
function didLoseStock(frame, prevFrame) {
    if (!frame || !prevFrame) {
        return false;
    }
    return prevFrame.stocksRemaining - frame.stocksRemaining > 0;
}
function isInControl(state) {
    var ground = state >= exports.State.GROUNDED_CONTROL_START && state <= exports.State.GROUNDED_CONTROL_END;
    var squat = state >= exports.State.SQUAT_START && state <= exports.State.SQUAT_END;
    var groundAttack = state > exports.State.GROUND_ATTACK_START && state <= exports.State.GROUND_ATTACK_END;
    var isGrab = state === exports.State.GRAB;
    // TODO: Add grounded b moves?
    return ground || squat || groundAttack || isGrab;
}
function isTeching(state) {
    return state >= exports.State.TECH_START && state <= exports.State.TECH_END;
}
function isDown(state) {
    return state >= exports.State.DOWN_START && state <= exports.State.DOWN_END;
}
function isDamaged(state) {
    return state >= exports.State.DAMAGE_START && state <= exports.State.DAMAGE_END;
}
function isGrabbed(state) {
    return state >= exports.State.CAPTURE_START && state <= exports.State.CAPTURE_END;
}
function isDead(state) {
    return state >= exports.State.DYING_START && state <= exports.State.DYING_END;
}
function calcDamageTaken(frame, prevFrame) {
    var percent = ___default.get(frame, "percent", 0);
    var prevPercent = ___default.get(prevFrame, "percent", 0);
    return percent - prevPercent;
}

// @flow
// Frame pattern that indicates a dash dance turn was executed
var dashDanceAnimations = [exports.State.DASH, exports.State.TURN, exports.State.DASH];
var ActionsComputer = /** @class */ (function () {
    function ActionsComputer() {
        this.playerPermutations = new Array();
        this.state = new Map();
    }
    ActionsComputer.prototype.setPlayerPermutations = function (playerPermutations) {
        var _this = this;
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach(function (indices) {
            var playerCounts = {
                playerIndex: indices.playerIndex,
                opponentIndex: indices.opponentIndex,
                wavedashCount: 0,
                wavelandCount: 0,
                airDodgeCount: 0,
                dashDanceCount: 0,
                spotDodgeCount: 0,
                ledgegrabCount: 0,
                rollCount: 0,
            };
            var playerState = {
                playerCounts: playerCounts,
                animations: [],
            };
            _this.state.set(indices, playerState);
        });
    };
    ActionsComputer.prototype.processFrame = function (frame) {
        var _this = this;
        this.playerPermutations.forEach(function (indices) {
            var state = _this.state.get(indices);
            handleActionCompute(state, indices, frame);
        });
    };
    ActionsComputer.prototype.fetch = function () {
        var _this = this;
        return Array.from(this.state.keys()).map(function (key) { return _this.state.get(key).playerCounts; });
    };
    return ActionsComputer;
}());
function isRolling(animation) {
    return animation === exports.State.ROLL_BACKWARD || animation === exports.State.ROLL_FORWARD;
}
function didStartRoll(currentAnimation, previousAnimation) {
    var isCurrentlyRolling = isRolling(currentAnimation);
    var wasPreviouslyRolling = isRolling(previousAnimation);
    return isCurrentlyRolling && !wasPreviouslyRolling;
}
function isSpotDodging(animation) {
    return animation === exports.State.SPOT_DODGE;
}
function didStartSpotDodge(currentAnimation, previousAnimation) {
    var isCurrentlyDodging = isSpotDodging(currentAnimation);
    var wasPreviouslyDodging = isSpotDodging(previousAnimation);
    return isCurrentlyDodging && !wasPreviouslyDodging;
}
function isAirDodging(animation) {
    return animation === exports.State.AIR_DODGE;
}
function didStartAirDodge(currentAnimation, previousAnimation) {
    var isCurrentlyDodging = isAirDodging(currentAnimation);
    var wasPreviouslyDodging = isAirDodging(previousAnimation);
    return isCurrentlyDodging && !wasPreviouslyDodging;
}
function isGrabbingLedge(animation) {
    return animation === exports.State.CLIFF_CATCH;
}
function didStartLedgegrab(currentAnimation, previousAnimation) {
    var isCurrentlyGrabbingLedge = isGrabbingLedge(currentAnimation);
    var wasPreviouslyGrabbingLedge = isGrabbingLedge(previousAnimation);
    return isCurrentlyGrabbingLedge && !wasPreviouslyGrabbingLedge;
}
function handleActionCompute(state, indices, frame) {
    var playerFrame = frame.players[indices.playerIndex].post;
    var incrementCount = function (field, condition) {
        if (!condition) {
            return;
        }
        // FIXME: ActionsCountsType should be a map of actions -> number, instead of accessing the field via string
        state.playerCounts[field] += 1;
    };
    // Manage animation state
    state.animations.push(playerFrame.actionStateId);
    // Grab last 3 frames
    var last3Frames = state.animations.slice(-3);
    var currentAnimation = playerFrame.actionStateId;
    var prevAnimation = last3Frames[last3Frames.length - 2];
    // Increment counts based on conditions
    var didDashDance = ___default.isEqual(last3Frames, dashDanceAnimations);
    incrementCount("dashDanceCount", didDashDance);
    var didRoll = didStartRoll(currentAnimation, prevAnimation);
    incrementCount("rollCount", didRoll);
    var didSpotDodge = didStartSpotDodge(currentAnimation, prevAnimation);
    incrementCount("spotDodgeCount", didSpotDodge);
    var didAirDodge = didStartAirDodge(currentAnimation, prevAnimation);
    incrementCount("airDodgeCount", didAirDodge);
    var didGrabLedge = didStartLedgegrab(currentAnimation, prevAnimation);
    incrementCount("ledgegrabCount", didGrabLedge);
    // Handles wavedash detection (and waveland)
    handleActionWavedash(state.playerCounts, state.animations);
}
function handleActionWavedash(counts, animations) {
    var currentAnimation = ___default.last(animations);
    var prevAnimation = animations[animations.length - 2];
    var isSpecialLanding = currentAnimation === exports.State.LANDING_FALL_SPECIAL;
    var isAcceptablePrevious = isWavedashInitiationAnimation(prevAnimation);
    var isPossibleWavedash = isSpecialLanding && isAcceptablePrevious;
    if (!isPossibleWavedash) {
        return;
    }
    // Here we special landed, it might be a wavedash, let's check
    // We grab the last 8 frames here because that should be enough time to execute a
    // wavedash. This number could be tweaked if we find false negatives
    var recentFrames = animations.slice(-8);
    var recentAnimations = ___default.keyBy(recentFrames, function (animation) { return animation; });
    if (___default.size(recentAnimations) === 2 && recentAnimations[exports.State.AIR_DODGE]) {
        // If the only other animation is air dodge, this might be really late to the point
        // where it was actually an air dodge. Air dodge animation is really long
        return;
    }
    if (recentAnimations[exports.State.AIR_DODGE]) {
        // If one of the recent animations was an air dodge, let's remove that from the
        // air dodge counter, we don't want to count air dodges used to wavedash/land
        counts.airDodgeCount -= 1;
    }
    if (recentAnimations[exports.State.ACTION_KNEE_BEND]) {
        // If a jump was started recently, we will consider this a wavedash
        counts.wavedashCount += 1;
    }
    else {
        // If there was no jump recently, this is a waveland
        counts.wavelandCount += 1;
    }
}
function isWavedashInitiationAnimation(animation) {
    if (animation === exports.State.AIR_DODGE) {
        return true;
    }
    var isAboveMin = animation >= exports.State.CONTROLLED_JUMP_START;
    var isBelowMax = animation <= exports.State.CONTROLLED_JUMP_END;
    return isAboveMin && isBelowMax;
}

var ConversionComputer = /** @class */ (function () {
    function ConversionComputer() {
        this.playerPermutations = new Array();
        this.conversions = new Array();
        this.state = new Map();
        this.metadata = {
            lastEndFrameByOppIdx: {},
        };
    }
    ConversionComputer.prototype.setPlayerPermutations = function (playerPermutations) {
        var _this = this;
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach(function (indices) {
            var playerState = {
                conversion: null,
                move: null,
                resetCounter: 0,
                lastHitAnimation: null,
            };
            _this.state.set(indices, playerState);
        });
    };
    ConversionComputer.prototype.processFrame = function (frame, allFrames) {
        var _this = this;
        this.playerPermutations.forEach(function (indices) {
            var state = _this.state.get(indices);
            handleConversionCompute(allFrames, state, indices, frame, _this.conversions);
        });
    };
    ConversionComputer.prototype.fetch = function () {
        this._populateConversionTypes();
        return this.conversions;
    };
    ConversionComputer.prototype._populateConversionTypes = function () {
        var _this = this;
        // Post-processing step: set the openingTypes
        var conversionsToHandle = ___default.filter(this.conversions, function (conversion) {
            return conversion.openingType === "unknown";
        });
        // Group new conversions by startTime and sort
        var sortedConversions = ___default.chain(conversionsToHandle)
            .groupBy("startFrame")
            .orderBy(function (conversions) { return ___default.get(conversions, [0, "startFrame"]); })
            .value();
        // Set the opening types on the conversions we need to handle
        sortedConversions.forEach(function (conversions) {
            var isTrade = conversions.length >= 2;
            conversions.forEach(function (conversion) {
                // Set end frame for this conversion
                _this.metadata.lastEndFrameByOppIdx[conversion.playerIndex] = conversion.endFrame;
                if (isTrade) {
                    // If trade, just short-circuit
                    conversion.openingType = "trade";
                    return;
                }
                // If not trade, check the opponent endFrame
                var oppEndFrame = _this.metadata.lastEndFrameByOppIdx[conversion.opponentIndex];
                var isCounterAttack = oppEndFrame && oppEndFrame > conversion.startFrame;
                conversion.openingType = isCounterAttack ? "counter-attack" : "neutral-win";
            });
        });
    };
    return ConversionComputer;
}());
function handleConversionCompute(frames, state, indices, frame, conversions) {
    var playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    var prevPlayerFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.playerIndex, "post"], {});
    var opponentFrame = frame.players[indices.opponentIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    var prevOpponentFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.opponentIndex, "post"], {});
    var opntIsDamaged = isDamaged(opponentFrame.actionStateId);
    var opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
    var opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);
    // Keep track of whether actionState changes after a hit. Used to compute move count
    // When purely using action state there was a bug where if you did two of the same
    // move really fast (such as ganon's jab), it would count as one move. Added
    // the actionStateCounter at this point which counts the number of frames since
    // an animation started. Should be more robust, for old files it should always be
    // null and null < null = false
    var actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
    var actionCounter = playerFrame.actionStateCounter;
    var prevActionCounter = prevPlayerFrame.actionStateCounter;
    var actionFrameCounterReset = actionCounter < prevActionCounter;
    if (actionChangedSinceHit || actionFrameCounterReset) {
        state.lastHitAnimation = null;
    }
    // If opponent took damage and was put in some kind of stun this frame, either
    // start a conversion or
    if (opntIsDamaged || opntIsGrabbed) {
        if (!state.conversion) {
            state.conversion = {
                playerIndex: indices.playerIndex,
                opponentIndex: indices.opponentIndex,
                startFrame: playerFrame.frame,
                endFrame: null,
                startPercent: prevOpponentFrame.percent || 0,
                currentPercent: opponentFrame.percent || 0,
                endPercent: null,
                moves: [],
                didKill: false,
                openingType: "unknown",
            };
            conversions.push(state.conversion);
        }
        if (opntDamageTaken) {
            // If animation of last hit has been cleared that means this is a new move. This
            // prevents counting multiple hits from the same move such as fox's drill
            if (!state.lastHitAnimation) {
                state.move = {
                    frame: playerFrame.frame,
                    moveId: playerFrame.lastAttackLanded,
                    hitCount: 0,
                    damage: 0,
                };
                state.conversion.moves.push(state.move);
            }
            if (state.move) {
                state.move.hitCount += 1;
                state.move.damage += opntDamageTaken;
            }
            // Store previous frame animation to consider the case of a trade, the previous
            // frame should always be the move that actually connected... I hope
            state.lastHitAnimation = prevPlayerFrame.actionStateId;
        }
    }
    if (!state.conversion) {
        // The rest of the function handles conversion termination logic, so if we don't
        // have a conversion started, there is no need to continue
        return;
    }
    var opntInControl = isInControl(opponentFrame.actionStateId);
    var opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);
    // Update percent if opponent didn't lose stock
    if (!opntDidLoseStock) {
        state.conversion.currentPercent = opponentFrame.percent || 0;
    }
    if (opntIsDamaged || opntIsGrabbed) {
        // If opponent got grabbed or damaged, reset the reset counter
        state.resetCounter = 0;
    }
    var shouldStartResetCounter = state.resetCounter === 0 && opntInControl;
    var shouldContinueResetCounter = state.resetCounter > 0;
    if (shouldStartResetCounter || shouldContinueResetCounter) {
        // This will increment the reset timer under the following conditions:
        // 1) if we were punishing opponent but they have now entered an actionable state
        // 2) if counter has already started counting meaning opponent has entered actionable state
        state.resetCounter += 1;
    }
    var shouldTerminate = false;
    // Termination condition 1 - player kills opponent
    if (opntDidLoseStock) {
        state.conversion.didKill = true;
        shouldTerminate = true;
    }
    // Termination condition 2 - conversion resets on time
    if (state.resetCounter > Timers.PUNISH_RESET_FRAMES) {
        shouldTerminate = true;
    }
    // If conversion should terminate, mark the end states and add it to list
    if (shouldTerminate) {
        state.conversion.endFrame = playerFrame.frame;
        state.conversion.endPercent = prevOpponentFrame.percent || 0;
        state.conversion = null;
        state.move = null;
    }
}

var ComboComputer = /** @class */ (function () {
    function ComboComputer() {
        this.playerPermutations = new Array();
        this.state = new Map();
        this.combos = new Array();
    }
    ComboComputer.prototype.setPlayerPermutations = function (playerPermutations) {
        var _this = this;
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach(function (indices) {
            var playerState = {
                combo: null,
                move: null,
                resetCounter: 0,
                lastHitAnimation: null,
            };
            _this.state.set(indices, playerState);
        });
    };
    ComboComputer.prototype.processFrame = function (frame, allFrames) {
        var _this = this;
        this.playerPermutations.forEach(function (indices) {
            var state = _this.state.get(indices);
            handleComboCompute(allFrames, state, indices, frame, _this.combos);
        });
    };
    ComboComputer.prototype.fetch = function () {
        return this.combos;
    };
    return ComboComputer;
}());
function handleComboCompute(frames, state, indices, frame, combos) {
    var playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    var prevPlayerFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.playerIndex, "post"], {});
    var opponentFrame = frame.players[indices.opponentIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    var prevOpponentFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.opponentIndex, "post"], {});
    var opntIsDamaged = isDamaged(opponentFrame.actionStateId);
    var opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
    var opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);
    // Keep track of whether actionState changes after a hit. Used to compute move count
    // When purely using action state there was a bug where if you did two of the same
    // move really fast (such as ganon's jab), it would count as one move. Added
    // the actionStateCounter at this point which counts the number of frames since
    // an animation started. Should be more robust, for old files it should always be
    // null and null < null = false
    var actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
    var actionCounter = playerFrame.actionStateCounter;
    var prevActionCounter = prevPlayerFrame.actionStateCounter;
    var actionFrameCounterReset = actionCounter < prevActionCounter;
    if (actionChangedSinceHit || actionFrameCounterReset) {
        state.lastHitAnimation = null;
    }
    // If opponent took damage and was put in some kind of stun this frame, either
    // start a combo or count the moves for the existing combo
    if (opntIsDamaged || opntIsGrabbed) {
        if (!state.combo) {
            state.combo = {
                playerIndex: indices.playerIndex,
                opponentIndex: indices.opponentIndex,
                startFrame: playerFrame.frame,
                endFrame: null,
                startPercent: prevOpponentFrame.percent || 0,
                currentPercent: opponentFrame.percent || 0,
                endPercent: null,
                moves: [],
                didKill: false,
            };
            combos.push(state.combo);
        }
        if (opntDamageTaken) {
            // If animation of last hit has been cleared that means this is a new move. This
            // prevents counting multiple hits from the same move such as fox's drill
            if (!state.lastHitAnimation) {
                state.move = {
                    frame: playerFrame.frame,
                    moveId: playerFrame.lastAttackLanded,
                    hitCount: 0,
                    damage: 0,
                };
                state.combo.moves.push(state.move);
            }
            if (state.move) {
                state.move.hitCount += 1;
                state.move.damage += opntDamageTaken;
            }
            // Store previous frame animation to consider the case of a trade, the previous
            // frame should always be the move that actually connected... I hope
            state.lastHitAnimation = prevPlayerFrame.actionStateId;
        }
    }
    if (!state.combo) {
        // The rest of the function handles combo termination logic, so if we don't
        // have a combo started, there is no need to continue
        return;
    }
    var opntIsTeching = isTeching(opponentFrame.actionStateId);
    var opntIsDowned = isDown(opponentFrame.actionStateId);
    var opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);
    var opntIsDying = isDead(opponentFrame.actionStateId);
    // Update percent if opponent didn't lose stock
    if (!opntDidLoseStock) {
        state.combo.currentPercent = opponentFrame.percent || 0;
    }
    if (opntIsDamaged || opntIsGrabbed || opntIsTeching || opntIsDowned || opntIsDying) {
        // If opponent got grabbed or damaged, reset the reset counter
        state.resetCounter = 0;
    }
    else {
        state.resetCounter += 1;
    }
    var shouldTerminate = false;
    // Termination condition 1 - player kills opponent
    if (opntDidLoseStock) {
        state.combo.didKill = true;
        shouldTerminate = true;
    }
    // Termination condition 2 - combo resets on time
    if (state.resetCounter > Timers.COMBO_STRING_RESET_FRAMES) {
        shouldTerminate = true;
    }
    // If combo should terminate, mark the end states and add it to list
    if (shouldTerminate) {
        state.combo.endFrame = playerFrame.frame;
        state.combo.endPercent = prevOpponentFrame.percent || 0;
        state.combo = null;
        state.move = null;
    }
}

// @flow
var StockComputer = /** @class */ (function () {
    function StockComputer() {
        this.state = new Map();
        this.playerPermutations = new Array();
        this.stocks = new Array();
    }
    StockComputer.prototype.setPlayerPermutations = function (playerPermutations) {
        var _this = this;
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach(function (indices) {
            var playerState = {
                stock: null,
            };
            _this.state.set(indices, playerState);
        });
    };
    StockComputer.prototype.processFrame = function (frame, allFrames) {
        var _this = this;
        this.playerPermutations.forEach(function (indices) {
            var state = _this.state.get(indices);
            handleStockCompute(allFrames, state, indices, frame, _this.stocks);
        });
    };
    StockComputer.prototype.fetch = function () {
        return this.stocks;
    };
    return StockComputer;
}());
function handleStockCompute(frames, state, indices, frame, stocks) {
    var playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use PostFrameUpdateType instead of any
    var prevPlayerFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.playerIndex, "post"], {});
    // If there is currently no active stock, wait until the player is no longer spawning.
    // Once the player is no longer spawning, start the stock
    if (!state.stock) {
        var isPlayerDead = isDead(playerFrame.actionStateId);
        if (isPlayerDead) {
            return;
        }
        state.stock = {
            playerIndex: indices.playerIndex,
            opponentIndex: indices.opponentIndex,
            startFrame: playerFrame.frame,
            endFrame: null,
            startPercent: 0,
            endPercent: null,
            currentPercent: 0,
            count: playerFrame.stocksRemaining,
            deathAnimation: null,
        };
        stocks.push(state.stock);
    }
    else if (didLoseStock(playerFrame, prevPlayerFrame)) {
        state.stock.endFrame = playerFrame.frame;
        state.stock.endPercent = prevPlayerFrame.percent || 0;
        state.stock.deathAnimation = playerFrame.actionStateId;
        state.stock = null;
    }
    else {
        state.stock.currentPercent = playerFrame.percent || 0;
    }
}

var JoystickRegion;
(function (JoystickRegion) {
    JoystickRegion[JoystickRegion["DZ"] = 0] = "DZ";
    JoystickRegion[JoystickRegion["NE"] = 1] = "NE";
    JoystickRegion[JoystickRegion["SE"] = 2] = "SE";
    JoystickRegion[JoystickRegion["SW"] = 3] = "SW";
    JoystickRegion[JoystickRegion["NW"] = 4] = "NW";
    JoystickRegion[JoystickRegion["N"] = 5] = "N";
    JoystickRegion[JoystickRegion["E"] = 6] = "E";
    JoystickRegion[JoystickRegion["S"] = 7] = "S";
    JoystickRegion[JoystickRegion["W"] = 8] = "W";
})(JoystickRegion || (JoystickRegion = {}));
var InputComputer = /** @class */ (function () {
    function InputComputer() {
        this.playerPermutations = new Array();
        this.state = new Map();
    }
    InputComputer.prototype.setPlayerPermutations = function (playerPermutations) {
        var _this = this;
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach(function (indices) {
            var playerState = {
                playerIndex: indices.playerIndex,
                opponentIndex: indices.opponentIndex,
                inputCount: 0,
            };
            _this.state.set(indices, playerState);
        });
    };
    InputComputer.prototype.processFrame = function (frame, allFrames) {
        var _this = this;
        this.playerPermutations.forEach(function (indices) {
            var state = _this.state.get(indices);
            handleInputCompute(allFrames, state, indices, frame);
        });
    };
    InputComputer.prototype.fetch = function () {
        var _this = this;
        return Array.from(this.state.keys()).map(function (key) { return _this.state.get(key); });
    };
    return InputComputer;
}());
function handleInputCompute(frames, state, indices, frame) {
    var playerFrame = frame.players[indices.playerIndex].pre;
    // FIXME: use PreFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PreFrameUpdateType
    var prevPlayerFrame = ___default.get(frames, [playerFrame.frame - 1, "players", indices.playerIndex, "pre"], {});
    if (playerFrame.frame < exports.Frames.FIRST_PLAYABLE) {
        // Don't count inputs until the game actually starts
        return;
    }
    // First count the number of buttons that go from 0 to 1
    // Increment action count by amount of button presses
    var invertedPreviousButtons = ~prevPlayerFrame.physicalButtons;
    var currentButtons = playerFrame.physicalButtons;
    var buttonChanges = invertedPreviousButtons & currentButtons & 0xfff;
    state.inputCount += countSetBits(buttonChanges);
    // Increment action count when sticks change from one region to another.
    // Don't increment when stick returns to deadzone
    var prevAnalogRegion = getJoystickRegion(prevPlayerFrame.joystickX, prevPlayerFrame.joystickY);
    var currentAnalogRegion = getJoystickRegion(playerFrame.joystickX, playerFrame.joystickY);
    if (prevAnalogRegion !== currentAnalogRegion && currentAnalogRegion !== 0) {
        state.inputCount += 1;
    }
    // Do the same for c-stick
    var prevCstickRegion = getJoystickRegion(prevPlayerFrame.cStickX, prevPlayerFrame.cStickY);
    var currentCstickRegion = getJoystickRegion(playerFrame.cStickX, playerFrame.cStickY);
    if (prevCstickRegion !== currentCstickRegion && currentCstickRegion !== 0) {
        state.inputCount += 1;
    }
    // Increment action on analog trigger... I'm not sure when. This needs revision
    // Currently will update input count when the button gets pressed past 0.3
    // Changes from hard shield to light shield should probably count as inputs but
    // are not counted here
    // FIXME: the lTrigger parameter does not exist on the PreFrameUpdateType
    if (prevPlayerFrame.lTrigger < 0.3 && playerFrame.lTrigger >= 0.3) {
        state.inputCount += 1;
    }
    // FIXME: the rTrigger parameter does not exist on the PreFrameUpdateType
    if (prevPlayerFrame.rTrigger < 0.3 && playerFrame.rTrigger >= 0.3) {
        state.inputCount += 1;
    }
}
function countSetBits(x) {
    // This function solves the Hamming Weight problem. Effectively it counts the number of
    // bits in the input that are set to 1
    // This implementation is supposedly very efficient when most bits are zero.
    // Found: https://en.wikipedia.org/wiki/Hamming_weight#Efficient_implementation
    var bits = x;
    var count;
    for (count = 0; bits; count += 1) {
        bits &= bits - 1;
    }
    return count;
}
function getJoystickRegion(x, y) {
    var region = JoystickRegion.DZ;
    if (x >= 0.2875 && y >= 0.2875) {
        region = JoystickRegion.NE;
    }
    else if (x >= 0.2875 && y <= -0.2875) {
        region = JoystickRegion.SE;
    }
    else if (x <= -0.2875 && y <= -0.2875) {
        region = JoystickRegion.SW;
    }
    else if (x <= -0.2875 && y >= 0.2875) {
        region = JoystickRegion.NW;
    }
    else if (y >= 0.2875) {
        region = JoystickRegion.N;
    }
    else if (x >= 0.2875) {
        region = JoystickRegion.E;
    }
    else if (y <= -0.2875) {
        region = JoystickRegion.S;
    }
    else if (x <= -0.2875) {
        region = JoystickRegion.W;
    }
    return region;
}

var defaultOptions = {
    processOnTheFly: false,
};
var Stats = /** @class */ (function () {
    function Stats(options) {
        this.lastProcessedFrame = null;
        this.frames = {};
        this.playerPermutations = new Array();
        this.allComputers = new Array();
        this.options = Object.assign({}, defaultOptions, options);
    }
    Stats.prototype.setPlayerPermutations = function (indices) {
        this.playerPermutations = indices;
        this.allComputers.forEach(function (comp) { return comp.setPlayerPermutations(indices); });
    };
    Stats.prototype.register = function () {
        var _a;
        var computer = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            computer[_i] = arguments[_i];
        }
        (_a = this.allComputers).push.apply(_a, computer);
    };
    Stats.prototype.process = function () {
        var _this = this;
        if (this.playerPermutations.length === 0) {
            return;
        }
        var i = this.lastProcessedFrame ? this.lastProcessedFrame + 1 : exports.Frames.FIRST;
        var _loop_1 = function () {
            var frame = this_1.frames[i];
            // Don't attempt to compute stats on frames that have not been fully received
            if (!isCompletedFrame(this_1.playerPermutations, frame)) {
                return { value: void 0 };
            }
            this_1.allComputers.forEach(function (comp) { return comp.processFrame(frame, _this.frames); });
            this_1.lastProcessedFrame = i;
            i++;
        };
        var this_1 = this;
        while (this.frames[i]) {
            var state_1 = _loop_1();
            if (typeof state_1 === "object")
                return state_1.value;
        }
    };
    Stats.prototype.addFrame = function (frame) {
        this.frames[frame.frame] = frame;
        if (this.options.processOnTheFly) {
            this.process();
        }
    };
    return Stats;
}());
function isCompletedFrame(playerPermutations, frame) {
    // This function checks whether we have successfully received an entire frame.
    // It is not perfect because it does not wait for follower frames. Fortunately,
    // follower frames are not used for any stat calculations so this doesn't matter
    // for our purposes.
    var indices = ___default.first(playerPermutations);
    var playerPostFrame = ___default.get(frame, ["players", indices.playerIndex, "post"]);
    var oppPostFrame = ___default.get(frame, ["players", indices.opponentIndex, "post"]);
    return Boolean(playerPostFrame && oppPostFrame);
}

function generateOverallStats(playerIndices, inputs, stocks, conversions, playableFrameCount) {
    var inputsByPlayer = ___default.keyBy(inputs, "playerIndex");
    var stocksByPlayer = ___default.groupBy(stocks, "playerIndex");
    var conversionsByPlayer = ___default.groupBy(conversions, "playerIndex");
    var conversionsByPlayerByOpening = ___default.mapValues(conversionsByPlayer, function (conversions) {
        return ___default.groupBy(conversions, "openingType");
    });
    var gameMinutes = playableFrameCount / 3600;
    var overall = playerIndices.map(function (indices) {
        var playerIndex = indices.playerIndex;
        var opponentIndex = indices.opponentIndex;
        var inputCount = ___default.get(inputsByPlayer, [playerIndex, "inputCount"]) || 0;
        var conversions = ___default.get(conversionsByPlayer, playerIndex) || [];
        var successfulConversions = conversions.filter(function (conversion) { return conversion.moves.length > 1; });
        var opponentStocks = ___default.get(stocksByPlayer, opponentIndex) || [];
        var opponentEndedStocks = ___default.filter(opponentStocks, "endFrame");
        var conversionCount = conversions.length;
        var successfulConversionCount = successfulConversions.length;
        var totalDamage = ___default.sumBy(opponentStocks, "currentPercent") || 0;
        var killCount = opponentEndedStocks.length;
        return {
            playerIndex: playerIndex,
            opponentIndex: opponentIndex,
            inputCount: inputCount,
            conversionCount: conversionCount,
            totalDamage: totalDamage,
            killCount: killCount,
            successfulConversions: getRatio(successfulConversionCount, conversionCount),
            inputsPerMinute: getRatio(inputCount, gameMinutes),
            openingsPerKill: getRatio(conversionCount, killCount),
            damagePerOpening: getRatio(totalDamage, conversionCount),
            neutralWinRatio: getOpeningRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex, "neutral-win"),
            counterHitRatio: getOpeningRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex, "counter-attack"),
            beneficialTradeRatio: getBeneficialTradeRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex),
        };
    });
    return overall;
}
function getRatio(count, total) {
    return {
        count: count,
        total: total,
        ratio: total ? count / total : null,
    };
}
function getOpeningRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex, type) {
    var openings = ___default.get(conversionsByPlayerByOpening, [playerIndex, type]) || [];
    var opponentOpenings = ___default.get(conversionsByPlayerByOpening, [opponentIndex, type]) || [];
    return getRatio(openings.length, openings.length + opponentOpenings.length);
}
function getBeneficialTradeRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex) {
    var playerTrades = ___default.get(conversionsByPlayerByOpening, [playerIndex, "trade"]) || [];
    var opponentTrades = ___default.get(conversionsByPlayerByOpening, [opponentIndex, "trade"]) || [];
    var benefitsPlayer = [];
    // Figure out which punishes benefited this player
    var zippedTrades = ___default.zip(playerTrades, opponentTrades);
    zippedTrades.forEach(function (conversionPair) {
        var playerConversion = ___default.first(conversionPair);
        var opponentConversion = ___default.last(conversionPair);
        var playerDamage = playerConversion.currentPercent - playerConversion.startPercent;
        var opponentDamage = opponentConversion.currentPercent - opponentConversion.startPercent;
        if (playerConversion.didKill && !opponentConversion.didKill) {
            benefitsPlayer.push(playerConversion);
        }
        else if (playerDamage > opponentDamage) {
            benefitsPlayer.push(playerConversion);
        }
    });
    return getRatio(benefitsPlayer.length, playerTrades.length);
}

/* eslint-disable no-param-reassign */
/**
 * Slippi Game class that wraps a file
 */
var SlippiGame = /** @class */ (function () {
    function SlippiGame(input, opts) {
        var _this = this;
        this.readPosition = null;
        this.actionsComputer = new ActionsComputer();
        this.conversionComputer = new ConversionComputer();
        this.comboComputer = new ComboComputer();
        this.stockComputer = new StockComputer();
        this.inputComputer = new InputComputer();
        if (___default.isString(input)) {
            this.input = {
                source: SlpInputSource.FILE,
                filePath: input,
            };
        }
        else if (input instanceof Buffer) {
            this.input = {
                source: SlpInputSource.BUFFER,
                buffer: input,
            };
        }
        else {
            throw new Error("Cannot create SlippiGame with input of that type");
        }
        // Set up stats calculation
        this.statsComputer = new Stats(opts);
        this.statsComputer.register(this.actionsComputer, this.comboComputer, this.conversionComputer, this.inputComputer, this.stockComputer);
        this.parser = new SlpParser();
        this.parser.on(exports.SlpParserEvent.SETTINGS, function (settings) {
            var playerPermutations = getSinglesPlayerPermutationsFromSettings(settings);
            _this.statsComputer.setPlayerPermutations(playerPermutations);
        });
        // Use finalized frames for stats computation
        this.parser.on(exports.SlpParserEvent.FINALIZED_FRAME, function (frame) {
            _this.statsComputer.addFrame(frame);
        });
    }
    SlippiGame.prototype._process = function (settingsOnly) {
        var _this = this;
        if (settingsOnly === void 0) { settingsOnly = false; }
        if (this.parser.getGameEnd() !== null) {
            return;
        }
        var slpfile = openSlpFile(this.input);
        // Generate settings from iterating through file
        this.readPosition = iterateEvents(slpfile, function (command, payload) {
            if (!payload) {
                // If payload is falsy, keep iterating. The parser probably just doesn't know
                // about this command yet
                return false;
            }
            _this.parser.handleCommand(command, payload);
            return settingsOnly && _this.parser.getSettings() !== null;
        }, this.readPosition);
        closeSlpFile(slpfile);
    };
    /**
     * Gets the game settings, these are the settings that describe the starting state of
     * the game such as characters, stage, etc.
     */
    SlippiGame.prototype.getSettings = function () {
        // Settings is only complete after post-frame update
        this._process(true);
        return this.parser.getSettings();
    };
    SlippiGame.prototype.getLatestFrame = function () {
        this._process();
        return this.parser.getLatestFrame();
    };
    SlippiGame.prototype.getGameEnd = function () {
        this._process();
        return this.parser.getGameEnd();
    };
    SlippiGame.prototype.getFrames = function () {
        this._process();
        return this.parser.getFrames();
    };
    SlippiGame.prototype.getStats = function () {
        if (this.finalStats) {
            return this.finalStats;
        }
        this._process();
        // Finish processing if we're not up to date
        this.statsComputer.process();
        var inputs = this.inputComputer.fetch();
        var stocks = this.stockComputer.fetch();
        var conversions = this.conversionComputer.fetch();
        var indices = getSinglesPlayerPermutationsFromSettings(this.parser.getSettings());
        var playableFrames = this.parser.getPlayableFrameCount();
        var overall = generateOverallStats(indices, inputs, stocks, conversions, playableFrames);
        var stats = {
            lastFrame: this.parser.getLatestFrameNumber(),
            playableFrameCount: playableFrames,
            stocks: stocks,
            conversions: conversions,
            combos: this.comboComputer.fetch(),
            actionCounts: this.actionsComputer.fetch(),
            overall: overall,
            gameComplete: this.parser.getGameEnd() !== null,
        };
        if (this.parser.getGameEnd() !== null) {
            // If the game is complete, store a cached version of stats because it should not
            // change anymore. Ideally the statsCompuer.process and fetch functions would simply do no
            // work in this case instead but currently the conversions fetch function,
            // generateOverallStats, and maybe more are doing work on every call.
            this.finalStats = stats;
        }
        return stats;
    };
    SlippiGame.prototype.getMetadata = function () {
        if (this.metadata) {
            return this.metadata;
        }
        var slpfile = openSlpFile(this.input);
        this.metadata = getMetadata(slpfile);
        closeSlpFile(slpfile);
        return this.metadata;
    };
    SlippiGame.prototype.getFilePath = function () {
        if (this.input.source !== SlpInputSource.FILE) {
            return null;
        }
        return this.input.filePath || null;
    };
    return SlippiGame;
}());
/* eslint-enable no-param-reassign */

// eslint-disable-next-line
function getDeathDirection(actionStateId) {
    if (actionStateId > 0xa) {
        return null;
    }
    switch (actionStateId) {
        case 0:
            return "down";
        case 1:
            return "left";
        case 2:
            return "right";
        default:
            return "up";
    }
}

var animations = /*#__PURE__*/Object.freeze({
  __proto__: null,
  getDeathDirection: getDeathDirection
});

var externalCharacters = [
    {
        id: 0,
        name: "Captain Falcon",
        shortName: "Falcon",
        colors: ["Default", "Black", "Red", "White", "Green", "Blue"],
    },
    {
        id: 1,
        name: "Donkey Kong",
        shortName: "DK",
        colors: ["Default", "Black", "Red", "Blue", "Green"],
    },
    {
        id: 2,
        name: "Fox",
        shortName: "Fox",
        colors: ["Default", "Red", "Blue", "Green"],
    },
    {
        id: 3,
        name: "Mr. Game & Watch",
        shortName: "G&W",
        colors: ["Default", "Red", "Blue", "Green"],
    },
    {
        id: 4,
        name: "Kirby",
        shortName: "Kirby",
        colors: ["Default", "Yellow", "Blue", "Red", "Green", "White"],
    },
    {
        id: 5,
        name: "Bowser",
        shortName: "Bowser",
        colors: ["Default", "Red", "Blue", "Black"],
    },
    {
        id: 6,
        name: "Link",
        shortName: "Link",
        colors: ["Default", "Red", "Blue", "Black", "White"],
    },
    {
        id: 7,
        name: "Luigi",
        shortName: "Luigi",
        colors: ["Default", "White", "Blue", "Red"],
    },
    {
        id: 8,
        name: "Mario",
        shortName: "Mario",
        colors: ["Default", "Yellow", "Black", "Blue", "Green"],
    },
    {
        id: 9,
        name: "Marth",
        shortName: "Marth",
        colors: ["Default", "Red", "Green", "Black", "White"],
    },
    {
        id: 10,
        name: "Mewtwo",
        shortName: "Mewtwo",
        colors: ["Default", "Red", "Blue", "Green"],
    },
    {
        id: 11,
        name: "Ness",
        shortName: "Ness",
        colors: ["Default", "Yellow", "Blue", "Green"],
    },
    {
        id: 12,
        name: "Peach",
        shortName: "Peach",
        colors: ["Default", "Daisy", "White", "Blue", "Green"],
    },
    {
        id: 13,
        name: "Pikachu",
        shortName: "Pikachu",
        colors: ["Default", "Red", "Party Hat", "Cowboy Hat"],
    },
    {
        id: 14,
        name: "Ice Climbers",
        shortName: "ICs",
        colors: ["Default", "Green", "Orange", "Red"],
    },
    {
        id: 15,
        name: "Jigglypuff",
        shortName: "Puff",
        colors: ["Default", "Red", "Blue", "Headband", "Crown"],
    },
    {
        id: 16,
        name: "Samus",
        shortName: "Samus",
        colors: ["Default", "Pink", "Black", "Green", "Purple"],
    },
    {
        id: 17,
        name: "Yoshi",
        shortName: "Yoshi",
        colors: ["Default", "Red", "Blue", "Yellow", "Pink", "Cyan"],
    },
    {
        id: 18,
        name: "Zelda",
        shortName: "Zelda",
        colors: ["Default", "Red", "Blue", "Green", "White"],
    },
    {
        id: 19,
        name: "Sheik",
        shortName: "Sheik",
        colors: ["Default", "Red", "Blue", "Green", "White"],
    },
    {
        id: 20,
        name: "Falco",
        shortName: "Falco",
        colors: ["Default", "Red", "Blue", "Green"],
    },
    {
        id: 21,
        name: "Young Link",
        shortName: "YLink",
        colors: ["Default", "Red", "Blue", "White", "Black"],
    },
    {
        id: 22,
        name: "Dr. Mario",
        shortName: "Doc",
        colors: ["Default", "Red", "Blue", "Green", "Black"],
    },
    {
        id: 23,
        name: "Roy",
        shortName: "Roy",
        colors: ["Default", "Red", "Blue", "Green", "Yellow"],
    },
    {
        id: 24,
        name: "Pichu",
        shortName: "Pichu",
        colors: ["Default", "Red", "Blue", "Green"],
    },
    {
        id: 25,
        name: "Ganondorf",
        shortName: "Ganon",
        colors: ["Default", "Red", "Blue", "Green", "Purple"],
    },
];
function getAllCharacters() {
    return externalCharacters;
}
function getCharacterInfo(externalCharacterId) {
    if (externalCharacterId < 0 || externalCharacterId >= externalCharacters.length) {
        throw new Error("Invalid character id: " + externalCharacterId);
    }
    return externalCharacters[externalCharacterId];
}
function getCharacterShortName(externalCharacterId) {
    var character = getCharacterInfo(externalCharacterId);
    return character.shortName;
}
function getCharacterName(externalCharacterId) {
    var character = getCharacterInfo(externalCharacterId);
    return character.name;
}
// Return a human-readable color from a characterCode.
function getCharacterColorName(externalCharacterId, characterColor) {
    var character = getCharacterInfo(externalCharacterId);
    var colors = character.colors;
    return colors[characterColor];
}

var characters = /*#__PURE__*/Object.freeze({
  __proto__: null,
  getAllCharacters: getAllCharacters,
  getCharacterInfo: getCharacterInfo,
  getCharacterShortName: getCharacterShortName,
  getCharacterName: getCharacterName,
  getCharacterColorName: getCharacterColorName
});

var UnknownMove = {
    id: -1,
    name: "Unknown Move",
    shortName: "unknown",
};
var moves = {
    1: {
        // This includes all thrown items, zair, luigi's taunt, samus bombs, etc
        id: 1,
        name: "Miscellaneous",
        shortName: "misc",
    },
    2: {
        id: 2,
        name: "Jab",
        shortName: "jab",
    },
    3: {
        id: 3,
        name: "Jab",
        shortName: "jab",
    },
    4: {
        id: 4,
        name: "Jab",
        shortName: "jab",
    },
    5: {
        id: 5,
        name: "Rapid Jabs",
        shortName: "rapid-jabs",
    },
    6: {
        id: 6,
        name: "Dash Attack",
        shortName: "dash",
    },
    7: {
        id: 7,
        name: "Forward Tilt",
        shortName: "ftilt",
    },
    8: {
        id: 8,
        name: "Up Tilt",
        shortName: "utilt",
    },
    9: {
        id: 9,
        name: "Down Tilt",
        shortName: "dtilt",
    },
    10: {
        id: 10,
        name: "Forward Smash",
        shortName: "fsmash",
    },
    11: {
        id: 11,
        name: "Up Smash",
        shortName: "usmash",
    },
    12: {
        id: 12,
        name: "Down Smash",
        shortName: "dsmash",
    },
    13: {
        id: 13,
        name: "Neutral Air",
        shortName: "nair",
    },
    14: {
        id: 14,
        name: "Forward Air",
        shortName: "fair",
    },
    15: {
        id: 15,
        name: "Back Air",
        shortName: "bair",
    },
    16: {
        id: 16,
        name: "Up Air",
        shortName: "uair",
    },
    17: {
        id: 17,
        name: "Down Air",
        shortName: "dair",
    },
    18: {
        id: 18,
        name: "Neutral B",
        shortName: "neutral-b",
    },
    19: {
        id: 19,
        name: "Side B",
        shortName: "side-b",
    },
    20: {
        id: 20,
        name: "Up B",
        shortName: "up-b",
    },
    21: {
        id: 21,
        name: "Down B",
        shortName: "down-b",
    },
    50: {
        id: 50,
        name: "Getup Attack",
        shortName: "getup",
    },
    51: {
        id: 51,
        name: "Getup Attack (Slow)",
        shortName: "getup-slow",
    },
    52: {
        id: 52,
        name: "Grab Pummel",
        shortName: "pummel",
    },
    53: {
        id: 53,
        name: "Forward Throw",
        shortName: "fthrow",
    },
    54: {
        id: 54,
        name: "Back Throw",
        shortName: "bthrow",
    },
    55: {
        id: 55,
        name: "Up Throw",
        shortName: "uthrow",
    },
    56: {
        id: 56,
        name: "Down Throw",
        shortName: "dthrow",
    },
    61: {
        id: 61,
        name: "Edge Attack (Slow)",
        shortName: "edge-slow",
    },
    62: {
        id: 62,
        name: "Edge Attack",
        shortName: "edge",
    },
};
function getMoveInfo(moveId) {
    var m = moves[moveId];
    if (!m) {
        return UnknownMove;
    }
    return m;
}
function getMoveShortName(moveId) {
    var move = getMoveInfo(moveId);
    return move.shortName;
}
function getMoveName(moveId) {
    var move = getMoveInfo(moveId);
    return move.name;
}

var moves$1 = /*#__PURE__*/Object.freeze({
  __proto__: null,
  UnknownMove: UnknownMove,
  getMoveInfo: getMoveInfo,
  getMoveShortName: getMoveShortName,
  getMoveName: getMoveName
});

var stages = {
    2: {
        id: 2,
        name: "Fountain of Dreams",
    },
    3: {
        id: 3,
        name: "Pokémon Stadium",
    },
    4: {
        id: 4,
        name: "Princess Peach's Castle",
    },
    5: {
        id: 5,
        name: "Kongo Jungle",
    },
    6: {
        id: 6,
        name: "Brinstar",
    },
    7: {
        id: 7,
        name: "Corneria",
    },
    8: {
        id: 8,
        name: "Yoshi's Story",
    },
    9: {
        id: 9,
        name: "Onett",
    },
    10: {
        id: 10,
        name: "Mute City",
    },
    11: {
        id: 11,
        name: "Rainbow Cruise",
    },
    12: {
        id: 12,
        name: "Jungle Japes",
    },
    13: {
        id: 13,
        name: "Great Bay",
    },
    14: {
        id: 14,
        name: "Hyrule Temple",
    },
    15: {
        id: 15,
        name: "Brinstar Depths",
    },
    16: {
        id: 16,
        name: "Yoshi's Island",
    },
    17: {
        id: 17,
        name: "Green Greens",
    },
    18: {
        id: 18,
        name: "Fourside",
    },
    19: {
        id: 19,
        name: "Mushroom Kingdom I",
    },
    20: {
        id: 20,
        name: "Mushroom Kingdom II",
    },
    22: {
        id: 22,
        name: "Venom",
    },
    23: {
        id: 23,
        name: "Poké Floats",
    },
    24: {
        id: 24,
        name: "Big Blue",
    },
    25: {
        id: 25,
        name: "Icicle Mountain",
    },
    26: {
        id: 26,
        name: "Icetop",
    },
    27: {
        id: 27,
        name: "Flat Zone",
    },
    28: {
        id: 28,
        name: "Dream Land N64",
    },
    29: {
        id: 29,
        name: "Yoshi's Island N64",
    },
    30: {
        id: 30,
        name: "Kongo Jungle N64",
    },
    31: {
        id: 31,
        name: "Battlefield",
    },
    32: {
        id: 32,
        name: "Final Destination",
    },
};
var STAGE_FOD = 2;
var STAGE_POKEMON = 3;
var STAGE_YOSHIS = 8;
var STAGE_DREAM_LAND = 28;
var STAGE_BATTLEFIELD = 31;
var STAGE_FD = 32;
function getStageInfo(stageId) {
    var s = stages[stageId];
    if (!s) {
        throw new Error("Invalid stage with id " + stageId);
    }
    return s;
}
function getStageName(stageId) {
    var stage = getStageInfo(stageId);
    return stage.name;
}

var stages$1 = /*#__PURE__*/Object.freeze({
  __proto__: null,
  STAGE_FOD: STAGE_FOD,
  STAGE_POKEMON: STAGE_POKEMON,
  STAGE_YOSHIS: STAGE_YOSHIS,
  STAGE_DREAM_LAND: STAGE_DREAM_LAND,
  STAGE_BATTLEFIELD: STAGE_BATTLEFIELD,
  STAGE_FD: STAGE_FD,
  getStageInfo: getStageInfo,
  getStageName: getStageName
});

var CommunicationType;
(function (CommunicationType) {
    CommunicationType[CommunicationType["HANDSHAKE"] = 1] = "HANDSHAKE";
    CommunicationType[CommunicationType["REPLAY"] = 2] = "REPLAY";
    CommunicationType[CommunicationType["KEEP_ALIVE"] = 3] = "KEEP_ALIVE";
})(CommunicationType || (CommunicationType = {}));
// This class is responsible for handling the communication protocol between the Wii and the
// desktop app
var ConsoleCommunication = /** @class */ (function () {
    function ConsoleCommunication() {
        this.receiveBuf = Buffer.from([]);
        this.messages = new Array();
    }
    ConsoleCommunication.prototype.receive = function (data) {
        this.receiveBuf = Buffer.concat([this.receiveBuf, data]);
        while (this.receiveBuf.length >= 4) {
            // First get the size of the message we are expecting
            var msgSize = this.receiveBuf.readUInt32BE(0);
            if (this.receiveBuf.length < msgSize + 4) {
                // If we haven't received all the data yet, let's wait for more
                return;
            }
            // Here we have received all the data, so let's decode it
            var ubjsonData = this.receiveBuf.slice(4, msgSize + 4);
            this.messages.push(ubjson.decode(ubjsonData));
            // Remove the processed data from receiveBuf
            this.receiveBuf = this.receiveBuf.slice(msgSize + 4);
        }
    };
    ConsoleCommunication.prototype.getReceiveBuffer = function () {
        return this.receiveBuf;
    };
    ConsoleCommunication.prototype.getMessages = function () {
        var toReturn = this.messages;
        this.messages = [];
        return toReturn;
    };
    ConsoleCommunication.prototype.genHandshakeOut = function (cursor, clientToken, isRealtime) {
        if (isRealtime === void 0) { isRealtime = false; }
        var clientTokenBuf = Buffer.from([0, 0, 0, 0]);
        clientTokenBuf.writeUInt32BE(clientToken, 0);
        var message = {
            type: CommunicationType.HANDSHAKE,
            payload: {
                cursor: cursor,
                clientToken: Uint8Array.from(clientTokenBuf),
                isRealtime: isRealtime,
            },
        };
        var buf = ubjson.encode(message, {
            optimizeArrays: true,
        });
        var msg = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(buf)]);
        msg.writeUInt32BE(buf.byteLength, 0);
        return msg;
    };
    return ConsoleCommunication;
}());

var NETWORK_MESSAGE = "HELO\0";
var DEFAULT_CONNECTION_TIMEOUT_MS = 20000;
(function (ConnectionEvent) {
    ConnectionEvent["HANDSHAKE"] = "handshake";
    ConnectionEvent["STATUS_CHANGE"] = "statusChange";
    ConnectionEvent["DATA"] = "data";
    ConnectionEvent["INFO"] = "loginfo";
    ConnectionEvent["WARN"] = "logwarn";
})(exports.ConnectionEvent || (exports.ConnectionEvent = {}));
(function (ConnectionStatus) {
    ConnectionStatus[ConnectionStatus["DISCONNECTED"] = 0] = "DISCONNECTED";
    ConnectionStatus[ConnectionStatus["CONNECTING"] = 1] = "CONNECTING";
    ConnectionStatus[ConnectionStatus["CONNECTED"] = 2] = "CONNECTED";
    ConnectionStatus[ConnectionStatus["RECONNECT_WAIT"] = 3] = "RECONNECT_WAIT";
})(exports.ConnectionStatus || (exports.ConnectionStatus = {}));
(function (Ports) {
    Ports[Ports["DEFAULT"] = 51441] = "DEFAULT";
    Ports[Ports["LEGACY"] = 666] = "LEGACY";
    Ports[Ports["RELAY_START"] = 53741] = "RELAY_START";
})(exports.Ports || (exports.Ports = {}));
var CommunicationState;
(function (CommunicationState) {
    CommunicationState["INITIAL"] = "initial";
    CommunicationState["LEGACY"] = "legacy";
    CommunicationState["NORMAL"] = "normal";
})(CommunicationState || (CommunicationState = {}));
var defaultConnectionDetails = {
    consoleNick: "unknown",
    gameDataCursor: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
    version: "",
    clientToken: 0,
};
/**
 * Responsible for maintaining connection to a Slippi relay connection or Wii connection.
 * Events are emitted whenever data is received.
 *
 * Basic usage example:
 *
 * ```javascript
 * const { ConsoleConnection } = require("@slippi/slippi-js");
 *
 * const connection = new ConsoleConnection();
 * connection.connect("localhost", 667); // You should set these values appropriately
 *
 * connection.on("data", (data) => {
 *   // Received data from console
 *   console.log(data);
 * });
 *
 * connection.on("statusChange", (status) => {
 *   console.log(`status changed: ${status}`);
 * });
 * ```
 */
var ConsoleConnection = /** @class */ (function (_super) {
    __extends(ConsoleConnection, _super);
    function ConsoleConnection() {
        var _this = _super.call(this) || this;
        _this.connectionStatus = exports.ConnectionStatus.DISCONNECTED;
        _this.connDetails = __assign({}, defaultConnectionDetails);
        _this.ipAddress = "0.0.0.0";
        _this.port = exports.Ports.DEFAULT;
        _this.clientsByPort = [];
        _this.connectionsByPort = [];
        return _this;
    }
    /**
     * @returns The current connection status.
     */
    ConsoleConnection.prototype.getStatus = function () {
        return this.connectionStatus;
    };
    /**
     * @returns The IP address and port of the current connection.
     */
    ConsoleConnection.prototype.getSettings = function () {
        return {
            ipAddress: this.ipAddress,
            port: this.port,
        };
    };
    /**
     * @returns The specific details about the connected console.
     */
    ConsoleConnection.prototype.getDetails = function () {
        return this.connDetails;
    };
    /**
     * Initiate a connection to the Wii or Slippi relay.
     * @param ip   The IP address of the Wii or Slippi relay.
     * @param port The port to connect to.
     * @param timeout Optional. The timeout in milliseconds when attempting to connect
     *                to the Wii or relay. Default: 5000.
     */
    ConsoleConnection.prototype.connect = function (ip, port, timeout) {
        if (timeout === void 0) { timeout = DEFAULT_CONNECTION_TIMEOUT_MS; }
        this.ipAddress = ip;
        this.port = port;
        if (port === exports.Ports.LEGACY || port === exports.Ports.DEFAULT) {
            // Connect to both legacy and default in case somebody accidentally set it
            // and they would encounter issues with the new Nintendont
            this._connectOnPort(exports.Ports.DEFAULT, timeout);
            this._connectOnPort(exports.Ports.LEGACY, timeout);
        }
        else {
            // If port is manually set, use that port.
            this._connectOnPort(port, timeout);
        }
    };
    ConsoleConnection.prototype._connectOnPort = function (port, timeout) {
        var _this = this;
        // set up reconnect
        var reconnect = inject(function () {
            return net.connect({
                host: _this.ipAddress,
                port: port,
                timeout: timeout,
            });
        });
        // Indicate we are connecting
        this._setStatus(exports.ConnectionStatus.CONNECTING);
        // Prepare console communication obj for talking UBJSON
        var consoleComms = new ConsoleCommunication();
        // TODO: reconnect on failed reconnect, not sure how
        // TODO: to do this
        var connection = reconnect({
            initialDelay: 2000,
            maxDelay: 10000,
            strategy: "fibonacci",
            failAfter: Infinity,
        }, function (client) {
            _this.clientsByPort[port] = client;
            var commState = CommunicationState.INITIAL;
            client.on("data", function (data) {
                if (commState === CommunicationState.INITIAL) {
                    commState = _this._getInitialCommState(data);
                    console.log("Connected to " + _this.ipAddress + ":" + _this.port + " with type: " + commState);
                    _this._setStatus(exports.ConnectionStatus.CONNECTED);
                    console.log(data.toString("hex"));
                }
                if (commState === CommunicationState.LEGACY) {
                    // If the first message received was not a handshake message, either we
                    // connected to an old Nintendont version or a relay instance
                    _this._handleReplayData(data);
                    return;
                }
                try {
                    consoleComms.receive(data);
                }
                catch (err) {
                    console.warn("Failed to process new data from server...", {
                        error: err,
                        prevDataBuf: consoleComms.getReceiveBuffer(),
                        rcvData: data,
                    });
                    client.destroy();
                    return;
                }
                var messages = consoleComms.getMessages();
                // Process all of the received messages
                try {
                    messages.forEach(function (message) { return _this._processMessage(message); });
                }
                catch (err) {
                    // Disconnect client to send another handshake message
                    client.destroy();
                    console.error(err);
                }
            });
            client.on("timeout", function () {
                // const previouslyConnected = this.connectionStatus === ConnectionStatus.CONNECTED;
                console.warn("Attempted connection to " + _this.ipAddress + ":" + _this.port + " timed out after " + timeout + "ms");
                client.destroy();
            });
            client.on("end", function () {
                console.log("disconnect");
                client.destroy();
            });
            client.on("close", function () {
                console.log("connection was closed");
            });
            var handshakeMsgOut = consoleComms.genHandshakeOut(_this.connDetails.gameDataCursor, _this.connDetails.clientToken);
            client.write(handshakeMsgOut);
        });
        var setConnectingStatus = function () {
            // Indicate we are connecting
            _this._setStatus(exports.ConnectionStatus.CONNECTING);
        };
        connection.on("connect", setConnectingStatus);
        connection.on("reconnect", setConnectingStatus);
        connection.on("disconnect", function () {
            // If one of the connections was successful, we no longer need to try connecting this one
            _this.connectionsByPort.forEach(function (iConn, iPort) {
                if (iPort === port || !iConn.connected) {
                    // Only disconnect if a different connection was connected
                    return;
                }
                // Prevent reconnections and disconnect
                connection.reconnect = false;
                connection.disconnect();
            });
            // TODO: Figure out how to set RECONNECT_WAIT state here. Currently it will stay on
            // TODO: Connecting... forever
        });
        connection.on("error", function (error) {
            console.error("Connection on port " + port + " encountered an error.", error);
        });
        this.connectionsByPort[port] = connection;
        console.log("Starting connection");
        connection.connect(port);
    };
    /**
     * Terminate the current connection.
     */
    ConsoleConnection.prototype.disconnect = function () {
        console.log("Disconnect request");
        this.connectionsByPort.forEach(function (connection) {
            // Prevent reconnections and disconnect
            connection.reconnect = false; // eslint-disable-line
            connection.disconnect();
        });
        this.clientsByPort.forEach(function (client) {
            client.destroy();
        });
        this._setStatus(exports.ConnectionStatus.DISCONNECTED);
    };
    ConsoleConnection.prototype._getInitialCommState = function (data) {
        if (data.length < 13) {
            return CommunicationState.LEGACY;
        }
        var openingBytes = Buffer.from([0x7b, 0x69, 0x04, 0x74, 0x79, 0x70, 0x65, 0x55, 0x01]);
        var dataStart = data.slice(4, 13);
        return dataStart.equals(openingBytes) ? CommunicationState.NORMAL : CommunicationState.LEGACY;
    };
    ConsoleConnection.prototype._processMessage = function (message) {
        switch (message.type) {
            case CommunicationType.KEEP_ALIVE:
                // console.log("Keep alive message received");
                // TODO: This is the jankiest shit ever but it will allow for relay connections not
                // TODO: to time out as long as the main connection is still receving keep alive messages
                // TODO: Need to figure out a better solution for this. There should be no need to have an
                // TODO: active Wii connection for the relay connection to keep itself alive
                var fakeKeepAlive = Buffer.from(NETWORK_MESSAGE);
                this._handleReplayData(fakeKeepAlive);
                break;
            case CommunicationType.REPLAY:
                var readPos = Uint8Array.from(message.payload.pos);
                var cmp = Buffer.compare(this.connDetails.gameDataCursor, readPos);
                if (!message.payload.forcePos && cmp !== 0) {
                    console.warn("Position of received data is not what was expected. Expected, Received:", this.connDetails.gameDataCursor, readPos);
                    // The readPos is not the one we are waiting on, throw error
                    throw new Error("Position of received data is incorrect.");
                }
                if (message.payload.forcePos) {
                    console.warn("Overflow occured in Nintendont, data has likely been skipped and replay corrupted. " +
                        "Expected, Received:", this.connDetails.gameDataCursor, readPos);
                }
                this.connDetails.gameDataCursor = Uint8Array.from(message.payload.nextPos);
                var data = Uint8Array.from(message.payload.data);
                this._handleReplayData(data);
                break;
            case CommunicationType.HANDSHAKE:
                this.connDetails.consoleNick = message.payload.nick;
                var tokenBuf = Buffer.from(message.payload.clientToken);
                this.connDetails.clientToken = tokenBuf.readUInt32BE(0);
                this.connDetails.version = message.payload.nintendontVersion;
                this.connDetails.gameDataCursor = Uint8Array.from(message.payload.pos);
                this.emit(exports.ConnectionEvent.HANDSHAKE, this.connDetails);
                break;
        }
    };
    ConsoleConnection.prototype._handleReplayData = function (data) {
        this.emit(exports.ConnectionEvent.DATA, data);
    };
    ConsoleConnection.prototype._setStatus = function (status) {
        this.connectionStatus = status;
        this.emit(exports.ConnectionEvent.STATUS_CHANGE, this.connectionStatus);
    };
    return ConsoleConnection;
}(events.EventEmitter));

(function (SlpStreamMode) {
    SlpStreamMode["AUTO"] = "AUTO";
    SlpStreamMode["MANUAL"] = "MANUAL";
})(exports.SlpStreamMode || (exports.SlpStreamMode = {}));
var defaultSettings = {
    suppressErrors: false,
    mode: exports.SlpStreamMode.AUTO,
};
(function (SlpStreamEvent) {
    SlpStreamEvent["RAW"] = "slp-raw";
    SlpStreamEvent["COMMAND"] = "slp-command";
})(exports.SlpStreamEvent || (exports.SlpStreamEvent = {}));
/**
 * SlpStream is a writable stream of Slippi data. It passes the data being written in
 * and emits an event based on what kind of Slippi messages were processed.
 *
 * SlpStream emits two events: "slp-raw" and "slp-command". The "slp-raw" event emits the raw buffer
 * bytes whenever it processes each command. You can manually parse this or write it to a
 * file. The "slp-command" event returns the parsed payload which you can access the attributes.
 *
 * @class SlpStream
 * @extends {Writable}
 */
var SlpStream = /** @class */ (function (_super) {
    __extends(SlpStream, _super);
    /**
     *Creates an instance of SlpStream.
     * @param {Partial<SlpStreamSettings>} [slpOptions]
     * @param {WritableOptions} [opts]
     * @memberof SlpStream
     */
    function SlpStream(slpOptions, opts) {
        var _this = _super.call(this, opts) || this;
        _this.gameEnded = false; // True only if in manual mode and the game has completed
        _this.payloadSizes = null;
        _this.previousBuffer = Buffer.from([]);
        _this.settings = Object.assign({}, defaultSettings, slpOptions);
        return _this;
    }
    SlpStream.prototype.restart = function () {
        this.gameEnded = false;
        this.payloadSizes = null;
    };
    SlpStream.prototype._write = function (newData, encoding, callback) {
        if (encoding !== "buffer") {
            throw new Error("Unsupported stream encoding. Expected 'buffer' got '" + encoding + "'.");
        }
        // Join the current data with the old data
        var data = Uint8Array.from(Buffer.concat([this.previousBuffer, newData]));
        // Clear previous data
        this.previousBuffer = Buffer.from([]);
        var dataView = new DataView(data.buffer);
        // Iterate through the data
        var index = 0;
        while (index < data.length) {
            // We want to filter out the network messages
            if (Buffer.from(data.slice(index, index + 5)).toString() === NETWORK_MESSAGE) {
                index += 5;
                continue;
            }
            // Make sure we have enough data to read a full payload
            var command = dataView.getUint8(index);
            var payloadSize = this.payloadSizes && this.payloadSizes.has(command) ? this.payloadSizes.get(command) : 0;
            var remainingLen = data.length - index;
            if (remainingLen < payloadSize + 1) {
                // If remaining length is not long enough for full payload, save the remaining
                // data until we receive more data. The data has been split up.
                this.previousBuffer = data.slice(index);
                break;
            }
            // Only process if the game is still going
            if (this.settings.mode === exports.SlpStreamMode.MANUAL && this.gameEnded) {
                break;
            }
            // Increment by one for the command byte
            index += 1;
            var payloadPtr = data.slice(index);
            var payloadDataView = new DataView(data.buffer, index);
            var payloadLen = 0;
            try {
                payloadLen = this._processCommand(command, payloadPtr, payloadDataView);
            }
            catch (err) {
                // Only throw the error if we're not suppressing the errors
                if (!this.settings.suppressErrors) {
                    throw err;
                }
                payloadLen = 0;
            }
            index += payloadLen;
        }
        callback();
    };
    SlpStream.prototype._writeCommand = function (command, entirePayload, payloadSize) {
        var payloadBuf = entirePayload.slice(0, payloadSize);
        var bufToWrite = Buffer.concat([Buffer.from([command]), payloadBuf]);
        // Forward the raw buffer onwards
        this.emit(exports.SlpStreamEvent.RAW, {
            command: command,
            payload: bufToWrite,
        });
        return new Uint8Array(bufToWrite);
    };
    SlpStream.prototype._processCommand = function (command, entirePayload, dataView) {
        // Handle the message size command
        if (command === exports.Command.MESSAGE_SIZES && this.payloadSizes === null) {
            var payloadSize_1 = dataView.getUint8(0);
            // Set the payload sizes
            this.payloadSizes = processReceiveCommands(dataView);
            // Emit the raw command event
            this._writeCommand(command, entirePayload, payloadSize_1);
            this.emit(exports.SlpStreamEvent.COMMAND, {
                command: command,
                payload: this.payloadSizes,
            });
            return payloadSize_1;
        }
        var payloadSize = this.payloadSizes && this.payloadSizes.has(command) ? this.payloadSizes.get(command) : 0;
        // Fetch the payload and parse it
        var payload;
        var parsedPayload;
        if (payloadSize > 0) {
            payload = this._writeCommand(command, entirePayload, payloadSize);
            parsedPayload = parseMessage(command, payload);
        }
        if (!parsedPayload) {
            return payloadSize;
        }
        switch (command) {
            case exports.Command.GAME_END:
                // Stop parsing data until we manually restart the stream
                if (this.settings.mode === exports.SlpStreamMode.MANUAL) {
                    this.gameEnded = true;
                }
                else {
                    // We're in auto-mode so reset the payload sizes for the next game
                    this.payloadSizes = null;
                }
                break;
        }
        this.emit(exports.SlpStreamEvent.COMMAND, {
            command: command,
            payload: parsedPayload,
        });
        return payloadSize;
    };
    return SlpStream;
}(stream.Writable));
var processReceiveCommands = function (dataView) {
    var payloadSizes = new Map();
    var payloadLen = dataView.getUint8(0);
    for (var i = 1; i < payloadLen; i += 3) {
        var commandByte = dataView.getUint8(i);
        var payloadSize = dataView.getUint16(i + 1);
        payloadSizes.set(commandByte, payloadSize);
    }
    return payloadSizes;
};

var DEFAULT_NICKNAME = "unknown";
/**
 * SlpFile is a class that wraps a Writable stream. It handles the writing of the binary
 * header and footer, and also handles the overwriting of the raw data length.
 *
 * @class SlpFile
 * @extends {Writable}
 */
var SlpFile = /** @class */ (function (_super) {
    __extends(SlpFile, _super);
    /**
     * Creates an instance of SlpFile.
     * @param {string} filePath The file location to write to.
     * @param {WritableOptions} [opts] Options for writing.
     * @memberof SlpFile
     */
    function SlpFile(filePath, slpStream, opts) {
        var _this = _super.call(this, opts) || this;
        _this.rawDataLength = 0;
        _this.usesExternalStream = false;
        _this.filePath = filePath;
        _this.metadata = {
            consoleNickname: DEFAULT_NICKNAME,
            startTime: moment(),
            lastFrame: -124,
            players: {},
        };
        _this.usesExternalStream = Boolean(slpStream);
        // Create a new SlpStream if one wasn't already provided
        // This SLP stream represents a single game not multiple, so use manual mode
        _this.slpStream = slpStream ? slpStream : new SlpStream({ mode: exports.SlpStreamMode.MANUAL });
        _this._setupListeners();
        _this._initializeNewGame(_this.filePath);
        return _this;
    }
    /**
     * Get the current file path being written to.
     *
     * @returns {string} The location of the current file path
     * @memberof SlpFile
     */
    SlpFile.prototype.path = function () {
        return this.filePath;
    };
    /**
     * Sets the metadata of the Slippi file, such as consoleNickname, lastFrame, and players.
     * @param metadata The metadata to be written
     */
    SlpFile.prototype.setMetadata = function (metadata) {
        this.metadata = Object.assign({}, this.metadata, metadata);
    };
    SlpFile.prototype._write = function (chunk, encoding, callback) {
        if (encoding !== "buffer") {
            throw new Error("Unsupported stream encoding. Expected 'buffer' got '" + encoding + "'.");
        }
        // Write it to the file
        this.fileStream.write(chunk);
        // Parse the data manually if it's an internal stream
        if (!this.usesExternalStream) {
            this.slpStream.write(chunk);
        }
        // Keep track of the bytes we've written
        this.rawDataLength += chunk.length;
        callback();
    };
    /**
     * Here we define what to do on each command. We need to populate the metadata field
     * so we keep track of the latest frame, as well as the number of frames each character has
     * been used.
     *
     * @param data The parsed data from a SlpStream
     */
    SlpFile.prototype._onCommand = function (data) {
        var _a;
        var command = data.command, payload = data.payload;
        switch (command) {
            case exports.Command.POST_FRAME_UPDATE:
                // Here we need to update some metadata fields
                var _b = payload, frame = _b.frame, playerIndex = _b.playerIndex, isFollower = _b.isFollower, internalCharacterId = _b.internalCharacterId;
                if (isFollower) {
                    // No need to do this for follower
                    break;
                }
                // Update frame index
                this.metadata.lastFrame = frame;
                // Update character usage
                var prevPlayer = _.get(this.metadata, ["players", "" + playerIndex]) || {};
                var characterUsage = prevPlayer.characterUsage || {};
                var curCharFrames = characterUsage[internalCharacterId] || 0;
                var player = __assign(__assign({}, prevPlayer), { characterUsage: __assign(__assign({}, characterUsage), (_a = {}, _a[internalCharacterId] = curCharFrames + 1, _a)) });
                this.metadata.players["" + playerIndex] = player;
                break;
        }
    };
    SlpFile.prototype._setupListeners = function () {
        var _this = this;
        var streamListener = function (data) {
            _this._onCommand(data);
        };
        this.slpStream.on(exports.SlpStreamEvent.COMMAND, streamListener);
        this.on("finish", function () {
            // Update file with bytes written
            var fd = fs.openSync(_this.filePath, "r+");
            fs.writeSync(fd, createUInt32Buffer(_this.rawDataLength), 0, "binary", 11);
            fs.closeSync(fd);
            // Unsubscribe from the stream
            _this.slpStream.removeListener(exports.SlpStreamEvent.COMMAND, streamListener);
            // Terminate the internal stream
            if (!_this.usesExternalStream) {
                _this.slpStream.end();
            }
        });
    };
    SlpFile.prototype._initializeNewGame = function (filePath) {
        this.fileStream = fs.createWriteStream(filePath, {
            encoding: "binary",
        });
        var header = Buffer.concat([
            Buffer.from("{U"),
            Buffer.from([3]),
            Buffer.from("raw[$U#l"),
            Buffer.from([0, 0, 0, 0]),
        ]);
        this.fileStream.write(header);
    };
    SlpFile.prototype._final = function (callback) {
        var footer = Buffer.concat([Buffer.from("U"), Buffer.from([8]), Buffer.from("metadata{")]);
        // Write game start time
        var startTimeStr = this.metadata.startTime.toISOString();
        footer = Buffer.concat([
            footer,
            Buffer.from("U"),
            Buffer.from([7]),
            Buffer.from("startAtSU"),
            Buffer.from([startTimeStr.length]),
            Buffer.from(startTimeStr),
        ]);
        // Write last frame index
        // TODO: Get last frame
        var lastFrame = this.metadata.lastFrame;
        footer = Buffer.concat([
            footer,
            Buffer.from("U"),
            Buffer.from([9]),
            Buffer.from("lastFramel"),
            createInt32Buffer(lastFrame),
        ]);
        // write the Console Nickname
        var consoleNick = this.metadata.consoleNickname || DEFAULT_NICKNAME;
        footer = Buffer.concat([
            footer,
            Buffer.from("U"),
            Buffer.from([11]),
            Buffer.from("consoleNickSU"),
            Buffer.from([consoleNick.length]),
            Buffer.from(consoleNick),
        ]);
        // Start writting player specific data
        footer = Buffer.concat([footer, Buffer.from("U"), Buffer.from([7]), Buffer.from("players{")]);
        var players = this.metadata.players;
        _.forEach(players, function (player, index) {
            // Start player obj with index being the player index
            footer = Buffer.concat([footer, Buffer.from("U"), Buffer.from([index.length]), Buffer.from(index + "{")]);
            // Start characters key for this player
            footer = Buffer.concat([footer, Buffer.from("U"), Buffer.from([10]), Buffer.from("characters{")]);
            // Write character usage
            _.forEach(player.characterUsage, function (usage, internalId) {
                // Write this character
                footer = Buffer.concat([
                    footer,
                    Buffer.from("U"),
                    Buffer.from([internalId.length]),
                    Buffer.from(internalId + "l"),
                    createUInt32Buffer(usage),
                ]);
            });
            // Close characters and player
            footer = Buffer.concat([footer, Buffer.from("}}")]);
        });
        // Close players
        footer = Buffer.concat([footer, Buffer.from("}")]);
        // Write played on
        footer = Buffer.concat([
            footer,
            Buffer.from("U"),
            Buffer.from([8]),
            Buffer.from("playedOnSU"),
            Buffer.from([7]),
            Buffer.from("network"),
        ]);
        // Close metadata and file
        footer = Buffer.concat([footer, Buffer.from("}}")]);
        // End the stream
        this.fileStream.write(footer, callback);
    };
    return SlpFile;
}(stream.Writable));
var createInt32Buffer = function (number) {
    var buf = Buffer.alloc(4);
    buf.writeInt32BE(number, 0);
    return buf;
};
var createUInt32Buffer = function (number) {
    var buf = Buffer.alloc(4);
    buf.writeUInt32BE(number, 0);
    return buf;
};

/**
 * The default function to use for generating new SLP files.
 */
function getNewFilePath(folder, m) {
    return path.join(folder, "Game_" + m.format("YYYYMMDD") + "T" + m.format("HHmmss") + ".slp");
}
var defaultSettings$1 = {
    outputFiles: true,
    folderPath: ".",
    consoleNickname: "unknown",
    newFilename: getNewFilePath,
};
(function (SlpFileWriterEvent) {
    SlpFileWriterEvent["NEW_FILE"] = "new-file";
    SlpFileWriterEvent["FILE_COMPLETE"] = "file-complete";
})(exports.SlpFileWriterEvent || (exports.SlpFileWriterEvent = {}));
/**
 * SlpFileWriter lets us not only emit events as an SlpStream but also
 * writes the data that is being passed in to an SLP file. Use this if
 * you want to process Slippi data in real time but also want to be able
 * to write out the data to an SLP file.
 *
 * @export
 * @class SlpFileWriter
 * @extends {SlpStream}
 */
var SlpFileWriter = /** @class */ (function (_super) {
    __extends(SlpFileWriter, _super);
    /**
     * Creates an instance of SlpFileWriter.
     */
    function SlpFileWriter(options, slpOptions, opts) {
        var _this = _super.call(this, slpOptions, opts) || this;
        _this.options = Object.assign({}, defaultSettings$1, options);
        _this._setupListeners();
        return _this;
    }
    SlpFileWriter.prototype._writePayload = function (payload) {
        // Write data to the current file
        if (this.currentFile) {
            this.currentFile.write(payload);
        }
    };
    SlpFileWriter.prototype._setupListeners = function () {
        var _this = this;
        this.on(exports.SlpStreamEvent.RAW, function (data) {
            var command = data.command, payload = data.payload;
            switch (command) {
                case exports.Command.MESSAGE_SIZES:
                    // Create the new game first before writing the payload
                    _this._handleNewGame();
                    _this._writePayload(payload);
                    break;
                case exports.Command.GAME_END:
                    // Write payload first before ending the game
                    _this._writePayload(payload);
                    _this._handleEndGame();
                    break;
                default:
                    _this._writePayload(payload);
                    break;
            }
        });
    };
    /**
     * Return the name of the SLP file currently being written or null if
     * no file is being written to currently.
     *
     * @returns {(string | null)}
     * @memberof SlpFileWriter
     */
    SlpFileWriter.prototype.getCurrentFilename = function () {
        if (this.currentFile !== null) {
            return path.resolve(this.currentFile.path());
        }
        return null;
    };
    /**
     * Updates the settings to be the desired ones passed in.
     *
     * @param {Partial<SlpFileWriterOptions>} settings
     * @memberof SlpFileWriter
     */
    SlpFileWriter.prototype.updateSettings = function (settings) {
        this.options = Object.assign({}, this.options, settings);
    };
    SlpFileWriter.prototype._handleNewGame = function () {
        // Only create a new file if we're outputting files
        if (this.options.outputFiles) {
            var filePath = this.options.newFilename(this.options.folderPath, moment());
            this.currentFile = new SlpFile(filePath, this);
            // console.log(`Creating new file at: ${filePath}`);
            this.emit(exports.SlpFileWriterEvent.NEW_FILE, filePath);
        }
    };
    SlpFileWriter.prototype._handleEndGame = function () {
        // End the stream
        if (this.currentFile) {
            // Set the console nickname
            this.currentFile.setMetadata({
                consoleNickname: this.options.consoleNickname,
            });
            this.currentFile.end();
            // console.log(`Finished writing file: ${this.currentFile.path()}`);
            this.emit(exports.SlpFileWriterEvent.FILE_COMPLETE, this.currentFile.path());
            // Clear current file
            this.currentFile = null;
        }
    };
    return SlpFileWriter;
}(SlpStream));

exports.ActionsComputer = ActionsComputer;
exports.ComboComputer = ComboComputer;
exports.ConsoleConnection = ConsoleConnection;
exports.ConversionComputer = ConversionComputer;
exports.InputComputer = InputComputer;
exports.MAX_ROLLBACK_FRAMES = MAX_ROLLBACK_FRAMES;
exports.NETWORK_MESSAGE = NETWORK_MESSAGE;
exports.SlippiGame = SlippiGame;
exports.SlpFile = SlpFile;
exports.SlpFileWriter = SlpFileWriter;
exports.SlpParser = SlpParser;
exports.SlpStream = SlpStream;
exports.Stats = Stats;
exports.StockComputer = StockComputer;
exports.Timers = Timers;
exports.animations = animations;
exports.calcDamageTaken = calcDamageTaken;
exports.characters = characters;
exports.default = SlippiGame;
exports.didLoseStock = didLoseStock;
exports.generateOverallStats = generateOverallStats;
exports.getSinglesPlayerPermutationsFromSettings = getSinglesPlayerPermutationsFromSettings;
exports.isDamaged = isDamaged;
exports.isDead = isDead;
exports.isDown = isDown;
exports.isGrabbed = isGrabbed;
exports.isInControl = isInControl;
exports.isTeching = isTeching;
exports.moves = moves$1;
exports.stages = stages$1;
