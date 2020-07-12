'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var _ = _interopDefault(require('lodash'));
var fs = _interopDefault(require('fs'));
var iconv = _interopDefault(require('iconv-lite'));
var ubjson = require('@shelacek/ubjson');
var semver = _interopDefault(require('semver'));

function toHalfwidth(str) {
    // Code reference from https://github.com/sampathsris/ascii-fullwidth-halfwidth-convert
    // Converts a fullwidth character to halfwidth
    const convertChar = (charCode) => {
        if (charCode > 0xFF00 && charCode < 0xFF5F) {
            return 0x0020 + (charCode - 0xFF00);
        }
        if (charCode === 0x3000) {
            return 0x0020;
        }
        return charCode;
    };
    const ret = _.map(str, char => (convertChar(char.charCodeAt(0))));
    return String.fromCharCode(...ret);
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
var SlpInputSource;
(function (SlpInputSource) {
    SlpInputSource["BUFFER"] = "buffer";
    SlpInputSource["FILE"] = "file";
})(SlpInputSource || (SlpInputSource = {}));
function getRef(input) {
    switch (input.source) {
        case SlpInputSource.FILE:
            const fd = fs.openSync(input.filePath, "r");
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
            const fileStats = fs.fstatSync(ref.fileDescriptor);
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
    const ref = getRef(input);
    const rawDataPosition = getRawDataPosition(ref);
    const rawDataLength = getRawDataLength(ref, rawDataPosition);
    const metadataPosition = rawDataPosition + rawDataLength + 10; // remove metadata string
    const metadataLength = getMetadataLength(ref, metadataPosition);
    const messageSizes = getMessageSizes(ref, rawDataPosition);
    return {
        ref: ref,
        rawDataPosition: rawDataPosition,
        rawDataLength: rawDataLength,
        metadataPosition: metadataPosition,
        metadataLength: metadataLength,
        messageSizes: messageSizes
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
    const buffer = new Uint8Array(1);
    readRef(ref, buffer, 0, buffer.length, 0);
    if (buffer[0] === 0x36) {
        return 0;
    }
    if (buffer[0] !== '{'.charCodeAt(0)) {
        return 0; // return error?
    }
    return 15;
}
function getRawDataLength(ref, position) {
    const fileSize = getLenRef(ref);
    if (position === 0) {
        return fileSize;
    }
    const buffer = new Uint8Array(4);
    readRef(ref, buffer, 0, buffer.length, position - 4);
    const rawDataLen = buffer[0] << 24 | buffer[1] << 16 | buffer[2] << 8 | buffer[3];
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
    const len = getLenRef(ref);
    return len - position - 1;
}
function getMessageSizes(ref, position) {
    const messageSizes = {};
    // Support old file format
    if (position === 0) {
        messageSizes[0x36] = 0x140;
        messageSizes[0x37] = 0x6;
        messageSizes[0x38] = 0x46;
        messageSizes[0x39] = 0x1;
        return messageSizes;
    }
    const buffer = new Uint8Array(2);
    readRef(ref, buffer, 0, buffer.length, position);
    if (buffer[0] !== exports.Command.MESSAGE_SIZES) {
        return {};
    }
    const payloadLength = buffer[1];
    messageSizes[0x35] = payloadLength;
    const messageSizesBuffer = new Uint8Array(payloadLength - 1);
    readRef(ref, messageSizesBuffer, 0, messageSizesBuffer.length, position + 2);
    for (let i = 0; i < payloadLength - 1; i += 3) {
        const command = messageSizesBuffer[i];
        // Get size of command
        messageSizes[command] = messageSizesBuffer[i + 1] << 8 | messageSizesBuffer[i + 2];
    }
    return messageSizes;
}
/**
 * Iterates through slp events and parses payloads
 */
function iterateEvents(slpFile, callback, startPos = null) {
    const ref = slpFile.ref;
    let readPosition = startPos || slpFile.rawDataPosition;
    const stopReadingAt = slpFile.rawDataPosition + slpFile.rawDataLength;
    // Generate read buffers for each
    const commandPayloadBuffers = _.mapValues(slpFile.messageSizes, (size) => (new Uint8Array(size + 1)));
    const commandByteBuffer = new Uint8Array(1);
    while (readPosition < stopReadingAt) {
        readRef(ref, commandByteBuffer, 0, 1, readPosition);
        const commandByte = commandByteBuffer[0];
        const buffer = commandPayloadBuffers[commandByte];
        if (buffer === undefined) {
            // If we don't have an entry for this command, return false to indicate failed read
            return readPosition;
        }
        if (buffer.length > stopReadingAt - readPosition) {
            return readPosition;
        }
        readRef(ref, buffer, 0, buffer.length, readPosition);
        const parsedPayload = parseMessage(commandByte, buffer);
        const shouldStop = callback(commandByte, parsedPayload);
        if (shouldStop) {
            break;
        }
        readPosition += buffer.length;
    }
    return readPosition;
}
function parseMessage(command, payload) {
    const view = new DataView(payload.buffer);
    switch (command) {
        case exports.Command.GAME_START:
            return {
                slpVersion: `${readUint8(view, 0x1)}.${readUint8(view, 0x2)}.${readUint8(view, 0x3)}`,
                isTeams: readBool(view, 0xD),
                isPAL: readBool(view, 0x1A1),
                stageId: readUint16(view, 0x13),
                players: [0, 1, 2, 3].map(playerIndex => {
                    // Controller Fix stuff
                    const cfOffset = playerIndex * 0x8;
                    const dashback = readUint32(view, 0x141 + cfOffset);
                    const shieldDrop = readUint32(view, 0x145 + cfOffset);
                    let cfOption = "None";
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
                    const nametagOffset = playerIndex * 0x10;
                    const nametagStart = 0x161 + nametagOffset;
                    const nametagBuf = payload.slice(nametagStart, nametagStart + 16);
                    const nametag = toHalfwidth(iconv.decode(nametagBuf, 'Shift_JIS').split('\0').shift());
                    const offset = playerIndex * 0x24;
                    return {
                        playerIndex: playerIndex,
                        port: playerIndex + 1,
                        characterId: readUint8(view, 0x65 + offset),
                        characterColor: readUint8(view, 0x68 + offset),
                        startStocks: readUint8(view, 0x67 + offset),
                        type: readUint8(view, 0x66 + offset),
                        teamId: readUint8(view, 0x6E + offset),
                        controllerFix: cfOption,
                        nametag: nametag,
                    };
                }),
            };
        case exports.Command.PRE_FRAME_UPDATE:
            return {
                frame: readInt32(view, 0x1),
                playerIndex: readUint8(view, 0x5),
                isFollower: readBool(view, 0x6),
                seed: readUint32(view, 0x7),
                actionStateId: readUint16(view, 0xB),
                positionX: readFloat(view, 0xD),
                positionY: readFloat(view, 0x11),
                facingDirection: readFloat(view, 0x15),
                joystickX: readFloat(view, 0x19),
                joystickY: readFloat(view, 0x1D),
                cStickX: readFloat(view, 0x21),
                cStickY: readFloat(view, 0x25),
                trigger: readFloat(view, 0x29),
                buttons: readUint32(view, 0x2D),
                physicalButtons: readUint16(view, 0x31),
                physicalLTrigger: readFloat(view, 0x33),
                physicalRTrigger: readFloat(view, 0x37),
                percent: readFloat(view, 0x3C),
            };
        case exports.Command.POST_FRAME_UPDATE:
            return {
                frame: readInt32(view, 0x1),
                playerIndex: readUint8(view, 0x5),
                isFollower: readBool(view, 0x6),
                internalCharacterId: readUint8(view, 0x7),
                actionStateId: readUint16(view, 0x8),
                positionX: readFloat(view, 0xA),
                positionY: readFloat(view, 0xE),
                facingDirection: readFloat(view, 0x12),
                percent: readFloat(view, 0x16),
                shieldSize: readFloat(view, 0x1A),
                lastAttackLanded: readUint8(view, 0x1E),
                currentComboCount: readUint8(view, 0x1F),
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
                velocityX: readFloat(view, 0xC),
                velocityY: readFloat(view, 0x10),
                positionX: readFloat(view, 0x14),
                positionY: readFloat(view, 0x18),
                damageTaken: readUint16(view, 0x1C),
                expirationTimer: readUint16(view, 0x1E),
                spawnId: readUint32(view, 0x20),
            };
        case exports.Command.FRAME_BOOKEND:
            return {
                frame: readInt32(view, 0x1),
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
    const viewLength = view.byteLength;
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
    const buffer = new Uint8Array(slpFile.metadataLength);
    readRef(slpFile.ref, buffer, 0, buffer.length, slpFile.metadataPosition);
    let metadata = null;
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
const Timers = {
    PUNISH_RESET_FRAMES: 45,
    RECOVERY_RESET_FRAMES: 45,
    COMBO_STRING_RESET_FRAMES: 45,
};
const Frames = {
    FIRST: -123,
    FIRST_PLAYABLE: -39,
};
function getSinglesPlayerPermutationsFromSettings(settings) {
    if (!settings || settings.players.length !== 2) {
        // Only return opponent indices for singles
        return [];
    }
    return [
        {
            playerIndex: settings.players[0].playerIndex,
            opponentIndex: settings.players[1].playerIndex
        }, {
            playerIndex: settings.players[1].playerIndex,
            opponentIndex: settings.players[0].playerIndex
        }
    ];
}
function didLoseStock(frame, prevFrame) {
    if (!frame || !prevFrame) {
        return false;
    }
    return (prevFrame.stocksRemaining - frame.stocksRemaining) > 0;
}
function isInControl(state) {
    const ground = state >= exports.State.GROUNDED_CONTROL_START && state <= exports.State.GROUNDED_CONTROL_END;
    const squat = state >= exports.State.SQUAT_START && state <= exports.State.SQUAT_END;
    const groundAttack = state > exports.State.GROUND_ATTACK_START && state <= exports.State.GROUND_ATTACK_END;
    const isGrab = state === exports.State.GRAB;
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
    const percent = _.get(frame, 'percent', 0);
    const prevPercent = _.get(prevFrame, 'percent', 0);
    return percent - prevPercent;
}

// @flow
// Frame pattern that indicates a dash dance turn was executed
const dashDanceAnimations = [exports.State.DASH, exports.State.TURN, exports.State.DASH];
class ActionsComputer {
    constructor() {
        this.playerPermutations = new Array();
        this.state = new Map();
    }
    setPlayerPermutations(playerPermutations) {
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach((indices) => {
            const playerCounts = {
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
            const playerState = {
                playerCounts: playerCounts,
                animations: [],
            };
            this.state.set(indices, playerState);
        });
    }
    processFrame(frame) {
        this.playerPermutations.forEach((indices) => {
            const state = this.state.get(indices);
            handleActionCompute(state, indices, frame);
        });
    }
    fetch() {
        return Array.from(this.state.keys()).map(key => this.state.get(key).playerCounts);
    }
}
function isRolling(animation) {
    return animation === exports.State.ROLL_BACKWARD || animation === exports.State.ROLL_FORWARD;
}
function didStartRoll(currentAnimation, previousAnimation) {
    const isCurrentlyRolling = isRolling(currentAnimation);
    const wasPreviouslyRolling = isRolling(previousAnimation);
    return isCurrentlyRolling && !wasPreviouslyRolling;
}
function isSpotDodging(animation) {
    return animation === exports.State.SPOT_DODGE;
}
function didStartSpotDodge(currentAnimation, previousAnimation) {
    const isCurrentlyDodging = isSpotDodging(currentAnimation);
    const wasPreviouslyDodging = isSpotDodging(previousAnimation);
    return isCurrentlyDodging && !wasPreviouslyDodging;
}
function isAirDodging(animation) {
    return animation === exports.State.AIR_DODGE;
}
function didStartAirDodge(currentAnimation, previousAnimation) {
    const isCurrentlyDodging = isAirDodging(currentAnimation);
    const wasPreviouslyDodging = isAirDodging(previousAnimation);
    return isCurrentlyDodging && !wasPreviouslyDodging;
}
function isGrabbingLedge(animation) {
    return animation === exports.State.CLIFF_CATCH;
}
function didStartLedgegrab(currentAnimation, previousAnimation) {
    const isCurrentlyGrabbingLedge = isGrabbingLedge(currentAnimation);
    const wasPreviouslyGrabbingLedge = isGrabbingLedge(previousAnimation);
    return isCurrentlyGrabbingLedge && !wasPreviouslyGrabbingLedge;
}
function handleActionCompute(state, indices, frame) {
    const playerFrame = frame.players[indices.playerIndex].post;
    const incrementCount = (field, condition) => {
        if (!condition) {
            return;
        }
        // FIXME: ActionsCountsType should be a map of actions -> number, instead of accessing the field via string
        state.playerCounts[field] += 1;
    };
    // Manage animation state
    state.animations.push(playerFrame.actionStateId);
    // Grab last 3 frames
    const last3Frames = state.animations.slice(-3);
    const currentAnimation = playerFrame.actionStateId;
    const prevAnimation = last3Frames[last3Frames.length - 2];
    // Increment counts based on conditions
    const didDashDance = _.isEqual(last3Frames, dashDanceAnimations);
    incrementCount('dashDanceCount', didDashDance);
    const didRoll = didStartRoll(currentAnimation, prevAnimation);
    incrementCount('rollCount', didRoll);
    const didSpotDodge = didStartSpotDodge(currentAnimation, prevAnimation);
    incrementCount('spotDodgeCount', didSpotDodge);
    const didAirDodge = didStartAirDodge(currentAnimation, prevAnimation);
    incrementCount('airDodgeCount', didAirDodge);
    const didGrabLedge = didStartLedgegrab(currentAnimation, prevAnimation);
    incrementCount('ledgegrabCount', didGrabLedge);
    // Handles wavedash detection (and waveland)
    handleActionWavedash(state.playerCounts, state.animations);
}
function handleActionWavedash(counts, animations) {
    const currentAnimation = _.last(animations);
    const prevAnimation = animations[animations.length - 2];
    const isSpecialLanding = currentAnimation === exports.State.LANDING_FALL_SPECIAL;
    const isAcceptablePrevious = isWavedashInitiationAnimation(prevAnimation);
    const isPossibleWavedash = isSpecialLanding && isAcceptablePrevious;
    if (!isPossibleWavedash) {
        return;
    }
    // Here we special landed, it might be a wavedash, let's check
    // We grab the last 8 frames here because that should be enough time to execute a
    // wavedash. This number could be tweaked if we find false negatives
    const recentFrames = animations.slice(-8);
    const recentAnimations = _.keyBy(recentFrames, (animation) => animation);
    if (_.size(recentAnimations) === 2 && recentAnimations[exports.State.AIR_DODGE]) {
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
    const isAboveMin = animation >= exports.State.CONTROLLED_JUMP_START;
    const isBelowMax = animation <= exports.State.CONTROLLED_JUMP_END;
    return isAboveMin && isBelowMax;
}

class ConversionComputer {
    constructor() {
        this.playerPermutations = new Array();
        this.conversions = new Array();
        this.state = new Map();
        this.metadata = {
            lastEndFrameByOppIdx: {},
        };
    }
    setPlayerPermutations(playerPermutations) {
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach((indices) => {
            const playerState = {
                conversion: null,
                move: null,
                resetCounter: 0,
                lastHitAnimation: null,
            };
            this.state.set(indices, playerState);
        });
    }
    processFrame(frame, allFrames) {
        this.playerPermutations.forEach((indices) => {
            const state = this.state.get(indices);
            handleConversionCompute(allFrames, state, indices, frame, this.conversions);
        });
    }
    fetch() {
        this._populateConversionTypes();
        return this.conversions;
    }
    _populateConversionTypes() {
        // Post-processing step: set the openingTypes
        const conversionsToHandle = _.filter(this.conversions, (conversion) => {
            return conversion.openingType === "unknown";
        });
        // Group new conversions by startTime and sort
        const sortedConversions = _.chain(conversionsToHandle)
            .groupBy('startFrame')
            .orderBy((conversions) => _.get(conversions, [0, 'startFrame']))
            .value();
        // Set the opening types on the conversions we need to handle
        sortedConversions.forEach(conversions => {
            const isTrade = conversions.length >= 2;
            conversions.forEach(conversion => {
                // Set end frame for this conversion
                this.metadata.lastEndFrameByOppIdx[conversion.playerIndex] = conversion.endFrame;
                if (isTrade) {
                    // If trade, just short-circuit
                    conversion.openingType = "trade";
                    return;
                }
                // If not trade, check the opponent endFrame
                const oppEndFrame = this.metadata.lastEndFrameByOppIdx[conversion.opponentIndex];
                const isCounterAttack = oppEndFrame && oppEndFrame > conversion.startFrame;
                conversion.openingType = isCounterAttack ? "counter-attack" : "neutral-win";
            });
        });
    }
}
function handleConversionCompute(frames, state, indices, frame, conversions) {
    const playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevPlayerFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.playerIndex, 'post'], {});
    const opponentFrame = frame.players[indices.opponentIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevOpponentFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.opponentIndex, 'post'], {});
    const opntIsDamaged = isDamaged(opponentFrame.actionStateId);
    const opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
    const opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);
    // Keep track of whether actionState changes after a hit. Used to compute move count
    // When purely using action state there was a bug where if you did two of the same
    // move really fast (such as ganon's jab), it would count as one move. Added
    // the actionStateCounter at this point which counts the number of frames since
    // an animation started. Should be more robust, for old files it should always be
    // null and null < null = false
    const actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
    const actionCounter = playerFrame.actionStateCounter;
    const prevActionCounter = prevPlayerFrame.actionStateCounter;
    const actionFrameCounterReset = actionCounter < prevActionCounter;
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
    const opntInControl = isInControl(opponentFrame.actionStateId);
    const opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);
    // Update percent if opponent didn't lose stock
    if (!opntDidLoseStock) {
        state.conversion.currentPercent = opponentFrame.percent || 0;
    }
    if (opntIsDamaged || opntIsGrabbed) {
        // If opponent got grabbed or damaged, reset the reset counter
        state.resetCounter = 0;
    }
    const shouldStartResetCounter = state.resetCounter === 0 && opntInControl;
    const shouldContinueResetCounter = state.resetCounter > 0;
    if (shouldStartResetCounter || shouldContinueResetCounter) {
        // This will increment the reset timer under the following conditions:
        // 1) if we were punishing opponent but they have now entered an actionable state
        // 2) if counter has already started counting meaning opponent has entered actionable state
        state.resetCounter += 1;
    }
    let shouldTerminate = false;
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

class ComboComputer {
    constructor() {
        this.playerPermutations = new Array();
        this.state = new Map();
        this.combos = new Array();
    }
    setPlayerPermutations(playerPermutations) {
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach((indices) => {
            const playerState = {
                combo: null,
                move: null,
                resetCounter: 0,
                lastHitAnimation: null,
            };
            this.state.set(indices, playerState);
        });
    }
    processFrame(frame, allFrames) {
        this.playerPermutations.forEach((indices) => {
            const state = this.state.get(indices);
            handleComboCompute(allFrames, state, indices, frame, this.combos);
        });
    }
    fetch() {
        return this.combos;
    }
}
function handleComboCompute(frames, state, indices, frame, combos) {
    const playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevPlayerFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.playerIndex, 'post'], {});
    const opponentFrame = frame.players[indices.opponentIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevOpponentFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.opponentIndex, 'post'], {});
    const opntIsDamaged = isDamaged(opponentFrame.actionStateId);
    const opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
    const opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);
    // Keep track of whether actionState changes after a hit. Used to compute move count
    // When purely using action state there was a bug where if you did two of the same
    // move really fast (such as ganon's jab), it would count as one move. Added
    // the actionStateCounter at this point which counts the number of frames since
    // an animation started. Should be more robust, for old files it should always be
    // null and null < null = false
    const actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
    const actionCounter = playerFrame.actionStateCounter;
    const prevActionCounter = prevPlayerFrame.actionStateCounter;
    const actionFrameCounterReset = actionCounter < prevActionCounter;
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
    const opntIsTeching = isTeching(opponentFrame.actionStateId);
    const opntIsDowned = isDown(opponentFrame.actionStateId);
    const opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);
    const opntIsDying = isDead(opponentFrame.actionStateId);
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
    let shouldTerminate = false;
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
class StockComputer {
    constructor() {
        this.state = new Map();
        this.playerPermutations = new Array();
        this.stocks = new Array();
    }
    setPlayerPermutations(playerPermutations) {
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach((indices) => {
            const playerState = {
                stock: null,
            };
            this.state.set(indices, playerState);
        });
    }
    processFrame(frame, allFrames) {
        this.playerPermutations.forEach((indices) => {
            const state = this.state.get(indices);
            handleStockCompute(allFrames, state, indices, frame, this.stocks);
        });
    }
    fetch() {
        return this.stocks;
    }
}
function handleStockCompute(frames, state, indices, frame, stocks) {
    const playerFrame = frame.players[indices.playerIndex].post;
    // FIXME: use PostFrameUpdateType instead of any
    const prevPlayerFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.playerIndex, 'post'], {});
    // If there is currently no active stock, wait until the player is no longer spawning.
    // Once the player is no longer spawning, start the stock
    if (!state.stock) {
        const isPlayerDead = isDead(playerFrame.actionStateId);
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
class InputComputer {
    constructor() {
        this.playerPermutations = new Array();
        this.state = new Map();
    }
    setPlayerPermutations(playerPermutations) {
        this.playerPermutations = playerPermutations;
        this.playerPermutations.forEach((indices) => {
            const playerState = {
                playerIndex: indices.playerIndex,
                opponentIndex: indices.opponentIndex,
                inputCount: 0,
            };
            this.state.set(indices, playerState);
        });
    }
    processFrame(frame, allFrames) {
        this.playerPermutations.forEach((indices) => {
            const state = this.state.get(indices);
            handleInputCompute(allFrames, state, indices, frame);
        });
    }
    fetch() {
        return Array.from(this.state.keys()).map(key => this.state.get(key));
    }
}
function handleInputCompute(frames, state, indices, frame) {
    const playerFrame = frame.players[indices.playerIndex].pre;
    // FIXME: use PreFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PreFrameUpdateType
    const prevPlayerFrame = _.get(frames, [playerFrame.frame - 1, 'players', indices.playerIndex, 'pre'], {});
    if (playerFrame.frame < Frames.FIRST_PLAYABLE) {
        // Don't count inputs until the game actually starts
        return;
    }
    // First count the number of buttons that go from 0 to 1
    // Increment action count by amount of button presses
    const invertedPreviousButtons = ~prevPlayerFrame.physicalButtons;
    const currentButtons = playerFrame.physicalButtons;
    const buttonChanges = (invertedPreviousButtons & currentButtons) & 0xFFF;
    state.inputCount += countSetBits(buttonChanges);
    // Increment action count when sticks change from one region to another.
    // Don't increment when stick returns to deadzone
    const prevAnalogRegion = getJoystickRegion(prevPlayerFrame.joystickX, prevPlayerFrame.joystickY);
    const currentAnalogRegion = getJoystickRegion(playerFrame.joystickX, playerFrame.joystickY);
    if ((prevAnalogRegion !== currentAnalogRegion) && (currentAnalogRegion !== 0)) {
        state.inputCount += 1;
    }
    // Do the same for c-stick
    const prevCstickRegion = getJoystickRegion(prevPlayerFrame.cStickX, prevPlayerFrame.cStickY);
    const currentCstickRegion = getJoystickRegion(playerFrame.cStickX, playerFrame.cStickY);
    if ((prevCstickRegion !== currentCstickRegion) && (currentCstickRegion !== 0)) {
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
    let bits = x;
    let count;
    for (count = 0; bits; count += 1) {
        bits &= bits - 1;
    }
    return count;
}
function getJoystickRegion(x, y) {
    let region = JoystickRegion.DZ;
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

const defaultOptions = {
    processOnTheFly: false,
};
class Stats {
    constructor(options) {
        this.lastProcessedFrame = null;
        this.frames = {};
        this.playerPermutations = new Array();
        this.allComputers = new Array();
        this.options = options || defaultOptions;
    }
    setPlayerPermutations(indices) {
        this.playerPermutations = indices;
        this.allComputers.forEach(comp => comp.setPlayerPermutations(indices));
    }
    register(computer) {
        this.allComputers.push(computer);
    }
    registerAll(computers) {
        this.allComputers = this.allComputers.concat(computers);
    }
    process() {
        if (this.playerPermutations.length === 0) {
            return;
        }
        let i = this.lastProcessedFrame ? this.lastProcessedFrame + 1 : Frames.FIRST;
        while (this.frames[i]) {
            const frame = this.frames[i];
            // Don't attempt to compute stats on frames that have not been fully received
            if (!isCompletedFrame(this.playerPermutations, frame)) {
                return;
            }
            this.allComputers.forEach(comp => comp.processFrame(frame, this.frames));
            this.lastProcessedFrame = i;
            i++;
        }
    }
    addFrame(frame) {
        this.frames[frame.frame] = frame;
        if (this.options.processOnTheFly) {
            this.process();
        }
    }
}
function isCompletedFrame(playerPermutations, frame) {
    // This function checks whether we have successfully received an entire frame.
    // It is not perfect because it does not wait for follower frames. Fortunately,
    // follower frames are not used for any stat calculations so this doesn't matter
    // for our purposes.
    const indices = _.first(playerPermutations);
    const playerPostFrame = _.get(frame, ['players', indices.playerIndex, 'post']);
    const oppPostFrame = _.get(frame, ['players', indices.opponentIndex, 'post']);
    return Boolean(playerPostFrame && oppPostFrame);
}

function generateOverallStats(playerIndices, inputs, stocks, conversions, playableFrameCount) {
    const inputsByPlayer = _.keyBy(inputs, 'playerIndex');
    const stocksByPlayer = _.groupBy(stocks, 'playerIndex');
    const conversionsByPlayer = _.groupBy(conversions, 'playerIndex');
    const conversionsByPlayerByOpening = _.mapValues(conversionsByPlayer, (conversions) => (_.groupBy(conversions, 'openingType')));
    const gameMinutes = playableFrameCount / 3600;
    const overall = playerIndices.map(indices => {
        const playerIndex = indices.playerIndex;
        const opponentIndex = indices.opponentIndex;
        const inputCount = _.get(inputsByPlayer, [playerIndex, 'inputCount']) || 0;
        const conversions = _.get(conversionsByPlayer, playerIndex) || [];
        const successfulConversions = conversions.filter(conversion => conversion.moves.length > 1);
        const opponentStocks = _.get(stocksByPlayer, opponentIndex) || [];
        const opponentEndedStocks = _.filter(opponentStocks, 'endFrame');
        const conversionCount = conversions.length;
        const successfulConversionCount = successfulConversions.length;
        const totalDamage = _.sumBy(opponentStocks, 'currentPercent') || 0;
        const killCount = opponentEndedStocks.length;
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
            neutralWinRatio: getOpeningRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex, 'neutral-win'),
            counterHitRatio: getOpeningRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex, 'counter-attack'),
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
    const openings = _.get(conversionsByPlayerByOpening, [playerIndex, type]) || [];
    const opponentOpenings = _.get(conversionsByPlayerByOpening, [opponentIndex, type]) || [];
    return getRatio(openings.length, openings.length + opponentOpenings.length);
}
function getBeneficialTradeRatio(conversionsByPlayerByOpening, playerIndex, opponentIndex) {
    const playerTrades = _.get(conversionsByPlayerByOpening, [playerIndex, 'trade']) || [];
    const opponentTrades = _.get(conversionsByPlayerByOpening, [opponentIndex, 'trade']) || [];
    const benefitsPlayer = [];
    // Figure out which punishes benefited this player
    const zippedTrades = _.zip(playerTrades, opponentTrades);
    zippedTrades.forEach((conversionPair) => {
        const playerConversion = _.first(conversionPair);
        const opponentConversion = _.last(conversionPair);
        const playerDamage = playerConversion.currentPercent - playerConversion.startPercent;
        const opponentDamage = opponentConversion.currentPercent - opponentConversion.startPercent;
        if (playerConversion.didKill && !opponentConversion.didKill) {
            benefitsPlayer.push(playerConversion);
        }
        else if (playerDamage > opponentDamage) {
            benefitsPlayer.push(playerConversion);
        }
    });
    return getRatio(benefitsPlayer.length, playerTrades.length);
}

class SlpParser {
    constructor(statsComputer) {
        this.frames = {};
        this.settings = null;
        this.gameEnd = null;
        this.latestFrameIndex = null;
        this.playerPermutations = new Array();
        this.settingsComplete = false;
        this.statsComputer = statsComputer;
    }
    getLatestFrameNumber() {
        return this.latestFrameIndex;
    }
    getPlayableFrameCount() {
        return this.latestFrameIndex < Frames.FIRST_PLAYABLE ? 0 : this.latestFrameIndex - Frames.FIRST_PLAYABLE;
    }
    getLatestFrame() {
        // return this.playerFrames[this.latestFrameIndex];
        // TODO: Modify this to check if we actually have all the latest frame data and return that
        // TODO: If we do. For now I'm just going to take a shortcut
        const allFrames = this.getFrames();
        const frameIndex = this.latestFrameIndex || Frames.FIRST;
        const indexToUse = this.gameEnd ? frameIndex : frameIndex - 1;
        return _.get(allFrames, indexToUse) || null;
    }
    getSettings() {
        return this.settingsComplete ? this.settings : null;
    }
    getGameEnd() {
        return this.gameEnd;
    }
    getFrames() {
        return this.frames;
    }
    handleGameEnd(payload) {
        payload = payload;
        this.gameEnd = payload;
    }
    handleGameStart(payload) {
        this.settings = payload;
        const players = payload.players;
        this.settings.players = players.filter(player => player.type !== 3);
        this.playerPermutations = getSinglesPlayerPermutationsFromSettings(this.settings);
        this.statsComputer.setPlayerPermutations(this.playerPermutations);
        // Check to see if the file was created after the sheik fix so we know
        // we don't have to process the first frame of the game for the full settings
        if (semver.gte(payload.slpVersion, "1.6.0")) {
            this.settingsComplete = true;
        }
    }
    handlePostFrameUpdate(payload) {
        if (this.settingsComplete) {
            return;
        }
        // Finish calculating settings
        if (payload.frame <= Frames.FIRST) {
            const playerIndex = payload.playerIndex;
            const playersByIndex = _.keyBy(this.settings.players, 'playerIndex');
            switch (payload.internalCharacterId) {
                case 0x7:
                    playersByIndex[playerIndex].characterId = 0x13; // Sheik
                    break;
                case 0x13:
                    playersByIndex[playerIndex].characterId = 0x12; // Zelda
                    break;
            }
        }
        this.settingsComplete = payload.frame > Frames.FIRST;
    }
    handleFrameUpdate(command, payload) {
        payload = payload;
        const location = command === exports.Command.PRE_FRAME_UPDATE ? "pre" : "post";
        const field = payload.isFollower ? 'followers' : 'players';
        this.latestFrameIndex = payload.frame;
        _.set(this.frames, [payload.frame, field, payload.playerIndex, location], payload);
        _.set(this.frames, [payload.frame, 'frame'], payload.frame);
        // If file is from before frame bookending, add frame to stats computer here. Does a little
        // more processing than necessary, but it works
        const settings = this.getSettings();
        if (!settings || semver.lte(settings.slpVersion, "2.2.0")) {
            this.statsComputer.addFrame(this.frames[payload.frame]);
        }
        else {
            _.set(this.frames, [payload.frame, 'isTransferComplete'], false);
        }
    }
    handleItemUpdate(command, payload) {
        const items = _.get(this.frames, [payload.frame, 'items'], []);
        items.push(payload);
        // Set items with newest
        _.set(this.frames, [payload.frame, 'items'], items);
    }
    handleFrameBookend(command, payload) {
        _.set(this.frames, [payload.frame, 'isTransferComplete'], true);
        this.statsComputer.addFrame(this.frames[payload.frame]);
    }
}

/* eslint-disable no-param-reassign */
/**
 * Slippi Game class that wraps a file
 */
class SlippiGame {
    constructor(input) {
        this.readPosition = null;
        this.actionsComputer = new ActionsComputer();
        this.conversionComputer = new ConversionComputer();
        this.comboComputer = new ComboComputer();
        this.stockComputer = new StockComputer();
        this.inputComputer = new InputComputer();
        this.statsComputer = new Stats();
        if (_.isString(input)) {
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
        this.statsComputer.registerAll([
            this.actionsComputer,
            this.comboComputer,
            this.conversionComputer,
            this.inputComputer,
            this.stockComputer,
        ]);
        this.parser = new SlpParser(this.statsComputer);
    }
    _process(settingsOnly = false) {
        if (this.parser.getGameEnd() !== null) {
            return;
        }
        const slpfile = openSlpFile(this.input);
        // Generate settings from iterating through file
        this.readPosition = iterateEvents(slpfile, (command, payload) => {
            if (!payload) {
                // If payload is falsy, keep iterating. The parser probably just doesn't know
                // about this command yet
                return false;
            }
            switch (command) {
                case exports.Command.GAME_START:
                    this.parser.handleGameStart(payload);
                    break;
                case exports.Command.POST_FRAME_UPDATE:
                    this.parser.handlePostFrameUpdate(payload);
                    this.parser.handleFrameUpdate(command, payload);
                    break;
                case exports.Command.PRE_FRAME_UPDATE:
                    this.parser.handleFrameUpdate(command, payload);
                    break;
                case exports.Command.ITEM_UPDATE:
                    this.parser.handleItemUpdate(command, payload);
                    break;
                case exports.Command.FRAME_BOOKEND:
                    this.parser.handleFrameBookend(command, payload);
                    break;
                case exports.Command.GAME_END:
                    this.parser.handleGameEnd(payload);
                    break;
            }
            return settingsOnly && this.parser.getSettings() !== null;
        }, this.readPosition);
        closeSlpFile(slpfile);
    }
    /**
     * Gets the game settings, these are the settings that describe the starting state of
     * the game such as characters, stage, etc.
     */
    getSettings() {
        // Settings is only complete after post-frame update
        this._process(true);
        return this.parser.getSettings();
    }
    getLatestFrame() {
        this._process();
        return this.parser.getLatestFrame();
    }
    getGameEnd() {
        this._process();
        return this.parser.getGameEnd();
    }
    getFrames() {
        this._process();
        return this.parser.getFrames();
    }
    getStats() {
        if (this.finalStats) {
            return this.finalStats;
        }
        this._process();
        // Finish processing if we're not up to date
        this.statsComputer.process();
        const inputs = this.inputComputer.fetch();
        const stocks = this.stockComputer.fetch();
        const conversions = this.conversionComputer.fetch();
        const indices = getSinglesPlayerPermutationsFromSettings(this.parser.getSettings());
        const playableFrames = this.parser.getPlayableFrameCount();
        const overall = generateOverallStats(indices, inputs, stocks, conversions, playableFrames);
        const stats = {
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
    }
    getMetadata() {
        if (this.metadata) {
            return this.metadata;
        }
        const slpfile = openSlpFile(this.input);
        this.metadata = getMetadata(slpfile);
        closeSlpFile(slpfile);
        return this.metadata;
    }
    getFilePath() {
        if (this.input.source !== SlpInputSource.FILE) {
            return null;
        }
        return this.input.filePath || null;
    }
}
/* eslint-enable no-param-reassign */

// eslint-disable-next-line
function getDeathDirection(actionStateId) {
    if (actionStateId > 0xa) {
        return null;
    }
    switch (actionStateId) {
        case 0:
            return 'down';
        case 1:
            return 'left';
        case 2:
            return 'right';
        default:
            return 'up';
    }
}

var animations = /*#__PURE__*/Object.freeze({
  getDeathDirection: getDeathDirection
});

const externalCharacters = [{
        id: 0,
        name: "Captain Falcon",
        shortName: "Falcon",
        colors: ["Default", "Black", "Red", "White", "Green", "Blue"],
    }, {
        id: 1,
        name: "Donkey Kong",
        shortName: "DK",
        colors: ["Default", "Black", "Red", "Blue", "Green"],
    }, {
        id: 2,
        name: "Fox",
        shortName: "Fox",
        colors: ["Default", "Red", "Blue", "Green"],
    }, {
        id: 3,
        name: "Mr. Game & Watch",
        shortName: "G&W",
        colors: ["Default", "Red", "Blue", "Green"],
    }, {
        id: 4,
        name: "Kirby",
        shortName: "Kirby",
        colors: ["Default", "Yellow", "Blue", "Red", "Green", "White"],
    }, {
        id: 5,
        name: "Bowser",
        shortName: "Bowser",
        colors: ["Default", "Red", "Blue", "Black"],
    }, {
        id: 6,
        name: "Link",
        shortName: "Link",
        colors: ["Default", "Red", "Blue", "Black", "White"],
    }, {
        id: 7,
        name: "Luigi",
        shortName: "Luigi",
        colors: ["Default", "White", "Blue", "Red"],
    }, {
        id: 8,
        name: "Mario",
        shortName: "Mario",
        colors: ["Default", "Yellow", "Black", "Blue", "Green"],
    }, {
        id: 9,
        name: "Marth",
        shortName: "Marth",
        colors: ["Default", "Red", "Green", "Black", "White"],
    }, {
        id: 10,
        name: "Mewtwo",
        shortName: "Mewtwo",
        colors: ["Default", "Red", "Blue", "Green"],
    }, {
        id: 11,
        name: "Ness",
        shortName: "Ness",
        colors: ["Default", "Yellow", "Blue", "Green"],
    }, {
        id: 12,
        name: "Peach",
        shortName: "Peach",
        colors: ["Default", "Daisy", "White", "Blue", "Green"],
    }, {
        id: 13,
        name: "Pikachu",
        shortName: "Pikachu",
        colors: ["Default", "Red", "Party Hat", "Cowboy Hat"],
    }, {
        id: 14,
        name: "Ice Climbers",
        shortName: "ICs",
        colors: ["Default", "Green", "Orange", "Red"],
    }, {
        id: 15,
        name: "Jigglypuff",
        shortName: "Puff",
        colors: ["Default", "Red", "Blue", "Headband", "Crown"],
    }, {
        id: 16,
        name: "Samus",
        shortName: "Samus",
        colors: ["Default", "Pink", "Black", "Green", "Purple"],
    }, {
        id: 17,
        name: "Yoshi",
        shortName: "Yoshi",
        colors: ["Default", "Red", "Blue", "Yellow", "Pink", "Cyan"],
    }, {
        id: 18,
        name: "Zelda",
        shortName: "Zelda",
        colors: ["Default", "Red", "Blue", "Green", "White"],
    }, {
        id: 19,
        name: "Sheik",
        shortName: "Sheik",
        colors: ["Default", "Red", "Blue", "Green", "White"],
    }, {
        id: 20,
        name: "Falco",
        shortName: "Falco",
        colors: ["Default", "Red", "Blue", "Green"],
    }, {
        id: 21,
        name: "Young Link",
        shortName: "YLink",
        colors: ["Default", "Red", "Blue", "White", "Black"],
    }, {
        id: 22,
        name: "Dr. Mario",
        shortName: "Doc",
        colors: ["Default", "Red", "Blue", "Green", "Black"],
    }, {
        id: 23,
        name: "Roy",
        shortName: "Roy",
        colors: ["Default", "Red", "Blue", "Green", "Yellow"],
    }, {
        id: 24,
        name: "Pichu",
        shortName: "Pichu",
        colors: ["Default", "Red", "Blue", "Green"],
    }, {
        id: 25,
        name: "Ganondorf",
        shortName: "Ganon",
        colors: ["Default", "Red", "Blue", "Green", "Purple"],
    }];
function getAllCharacters() {
    return externalCharacters;
}
function getCharacterInfo(externalCharacterId) {
    if (externalCharacterId < 0 || externalCharacterId >= externalCharacters.length) {
        throw new Error(`Invalid character id: ${externalCharacterId}`);
    }
    return externalCharacters[externalCharacterId];
}
function getCharacterShortName(externalCharacterId) {
    const character = getCharacterInfo(externalCharacterId);
    return character.shortName;
}
function getCharacterName(externalCharacterId) {
    const character = getCharacterInfo(externalCharacterId);
    return character.name;
}
// Return a human-readable color from a characterCode.
function getCharacterColorName(externalCharacterId, characterColor) {
    const character = getCharacterInfo(externalCharacterId);
    const colors = character.colors;
    return colors[characterColor];
}

var characters = /*#__PURE__*/Object.freeze({
  getAllCharacters: getAllCharacters,
  getCharacterInfo: getCharacterInfo,
  getCharacterShortName: getCharacterShortName,
  getCharacterName: getCharacterName,
  getCharacterColorName: getCharacterColorName
});

const UnknownMove = {
    id: -1,
    name: "Unknown Move",
    shortName: "unknown",
};
const moves = {
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
    const m = moves[moveId];
    if (!m) {
        return UnknownMove;
    }
    return m;
}
function getMoveShortName(moveId) {
    const move = getMoveInfo(moveId);
    return move.shortName;
}
function getMoveName(moveId) {
    const move = getMoveInfo(moveId);
    return move.name;
}

var moves$1 = /*#__PURE__*/Object.freeze({
  UnknownMove: UnknownMove,
  getMoveInfo: getMoveInfo,
  getMoveShortName: getMoveShortName,
  getMoveName: getMoveName
});

const stages = {
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
const STAGE_FOD = 2;
const STAGE_POKEMON = 3;
const STAGE_YOSHIS = 8;
const STAGE_DREAM_LAND = 28;
const STAGE_BATTLEFIELD = 31;
const STAGE_FD = 32;
function getStageInfo(stageId) {
    const s = stages[stageId];
    if (!s) {
        throw new Error(`Invalid stage with id ${stageId}`);
    }
    return s;
}
function getStageName(stageId) {
    const stage = getStageInfo(stageId);
    return stage.name;
}

var stages$1 = /*#__PURE__*/Object.freeze({
  STAGE_FOD: STAGE_FOD,
  STAGE_POKEMON: STAGE_POKEMON,
  STAGE_YOSHIS: STAGE_YOSHIS,
  STAGE_DREAM_LAND: STAGE_DREAM_LAND,
  STAGE_BATTLEFIELD: STAGE_BATTLEFIELD,
  STAGE_FD: STAGE_FD,
  getStageInfo: getStageInfo,
  getStageName: getStageName
});

exports.ActionsComputer = ActionsComputer;
exports.ComboComputer = ComboComputer;
exports.ConversionComputer = ConversionComputer;
exports.Frames = Frames;
exports.InputComputer = InputComputer;
exports.SlippiGame = SlippiGame;
exports.SlpParser = SlpParser;
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
exports.parseMessage = parseMessage;
exports.stages = stages$1;
