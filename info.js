let info = {};
info.state = (() => {
    let state = {};
    // Animation ID ranges
    state[state["DAMAGE_START"] = 75] = "DAMAGE_START";
    state[state["DAMAGE_END"] = 91] = "DAMAGE_END";
    state[state["CAPTURE_START"] = 223] = "CAPTURE_START";
    state[state["CAPTURE_END"] = 232] = "CAPTURE_END";
    state[state["GUARD_START"] = 178] = "GUARD_START";
    state[state["GUARD_END"] = 182] = "GUARD_END";
    state[state["GROUNDED_CONTROL_START"] = 14] = "GROUNDED_CONTROL_START";
    state[state["GROUNDED_CONTROL_END"] = 24] = "GROUNDED_CONTROL_END";
    state[state["SQUAT_START"] = 39] = "SQUAT_START";
    state[state["SQUAT_END"] = 41] = "SQUAT_END";
    state[state["DOWN_START"] = 183] = "DOWN_START";
    state[state["DOWN_END"] = 198] = "DOWN_END";
    state[state["TECH_START"] = 199] = "TECH_START";
    state[state["TECH_END"] = 204] = "TECH_END";
    state[state["DYING_START"] = 0] = "DYING_START";
    state[state["DYING_END"] = 10] = "DYING_END";
    state[state["CONTROLLED_JUMP_START"] = 24] = "CONTROLLED_JUMP_START";
    state[state["CONTROLLED_JUMP_END"] = 34] = "CONTROLLED_JUMP_END";
    state[state["GROUND_ATTACK_START"] = 44] = "GROUND_ATTACK_START";
    state[state["GROUND_ATTACK_END"] = 64] = "GROUND_ATTACK_END";
    // Animation ID specific
    state[state["PASS"] = 244] = "PASS";
    state[state["ROLL_FORWARD"] = 233] = "ROLL_FORWARD";
    state[state["ROLL_BACKWARD"] = 234] = "ROLL_BACKWARD";
    state[state["SPOT_DODGE"] = 235] = "SPOT_DODGE";
    state[state["AIR_DODGE"] = 236] = "AIR_DODGE";
    state[state["ACTION_WAIT"] = 14] = "ACTION_WAIT";
    state[state["ACTION_DASH"] = 20] = "ACTION_DASH";
    state[state["ACTION_KNEE_BEND"] = 24] = "ACTION_KNEE_BEND";
    state[state["GUARD_ON"] = 178] = "GUARD_ON";
    state[state["TECH_MISS_UP"] = 183] = "TECH_MISS_UP";
    state[state["TECH_MISS_DOWN"] = 191] = "TECH_MISS_DOWN";
    state[state["DASH"] = 20] = "DASH";
    state[state["TURN"] = 18] = "TURN";
    state[state["LANDING_FALL_SPECIAL"] = 43] = "LANDING_FALL_SPECIAL";
    state[state["JUMP_FORWARD"] = 25] = "JUMP_FORWARD";
    state[state["JUMP_BACKWARD"] = 26] = "JUMP_BACKWARD";
    state[state["FALL_FORWARD"] = 30] = "FALL_FORWARD";
    state[state["FALL_BACKWARD"] = 31] = "FALL_BACKWARD";
    state[state["GRAB"] = 212] = "GRAB";
    state[state["CLIFF_CATCH"] = 252] = "CLIFF_CATCH";
    return state;
})();
let stages = [{
    "id": 2,
    "name": "fod",
    "locations": [{
        "name": "left",
        "x1": -51,
        "x2": -19,
        "y": 15
    }, {
        "name": "right",
        "x1": 19,
        "x2": 51,
        "y": 15
    }, {
        "name": "top",
        "x1": -16,
        "x2": 16,
        "y": 41
    }, {
        "name": "base",
        "x1": -65,
        "x2": 65,
        "y": 0
    }]
}, {
    "id": 3,
    "name": "pokemon",
    "locations": [{
        "name": "left",
        "x1": -56,
        "x2": -24,
        "y": 15
    }, {
        "name": "right",
        "x1": 24,
        "x2": 56,
        "y": 15
    }, {
        "name": "base",
        "x1": -89,
        "x2": 89,
        "y": 0
    }]
}, {
    "id": 8,
    "name": "yoshis",
    "locations": [{
        "name": "left",
        "x1": -61,
        "x2": -27,
        "y": 21
    }, {
        "name": "right",
        "x1": 27,
        "x2": 61,
        "y": 21
    }, {
        "name": "top",
        "x1": -17,
        "x2": 17,
        "y": 40
    }, {
        "name": "base",
        "x1": -57,
        "x2": 57,
        "y": -5
    }]
}, {
    "id": 28,
    "name": "dreamland",
    "locations": [{
        "name": "left",
        "x1": -63,
        "x2": -31,
        "y": 28
    }, {
        "name": "right",
        "x1": 31,
        "x2": 64,
        "y": 28
    }, {
        "name": "top",
        "x1": -20,
        "x2": 20,
        "y": 50
    }, {
        "name": "base",
        "x1": -78,
        "x2": 78,
        "y": 0
    }]
}, {
    "id": 31,
    "name": "battlefield",
    "locations": [{
        "name": "left",
        "x1": -57.6,
        "x2": -20,
        "y": 27.2001
    }, {
        "name": "right",
        "x1": 20,
        "x2": 57.6,
        "y": 27.2001
    }, {
        "name": "top",
        "x1": -18.8,
        "x2": 18.8,
        "y": 54.4001
    }, {
        "name": "base",
        "x1": -68.4,
        "x2": 68.4,
        "y": 0.0001
    }]
}, {
    "id": 32,
    "name": "fd",
    "locations": [{
        "name": "base",
        "x1": -87,
        "x2": 87,
        "y": 0
    }]
}];
info.stages = {};
stages.map(stage => {
    info.stages[stage.name] = info.stages[stage.id] = stage;
})
module.exports = info;