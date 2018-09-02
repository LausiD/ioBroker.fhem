/* jshint -W097 */
/* jshint strict:false */
/* jslint node: true */

'use strict';

const utils = require(__dirname + '/lib/utils');
const Telnet = require(__dirname + '/lib/telnet');

const adapter = utils.Adapter('fhem');

// Telnet sessions
let telnetOut = null; // read config and write values
let telnetIn = null; // receive events

let connected = false;
const queue = [];
const queueL = [];
const fhemObjects = {};
const functions = {};

let lastNameQueue;
let lastNameTS = '0';                                                                                  // <-----------------------------------------------
let iobroker = false;
let firstRun = true;
let synchro = true;
const ignoreObjectsInternalsTYPE = ['no'];
const ignoreObjectsInternalsNAME = ['info'];
const ignoreObjectsAttributesroom = ['no'];
const ignorePossibleSets = ['getConfig', 'etRegRaw', 'egBulk', 'regSet', 'deviceMsg', 'CommandAccepted'];
const ignoreReadings = ['currentTrackPositionSimulated', 'currentTrackPositionSimulatedSec'];
const allowedAttributes = ['room', 'alias', 'disable', 'comment'];
const allowedInternals = ['TYPE', 'NAME', 'PORT', 'manufacturername', 'modelid', 'swversion'];
const dimPossibleSets = ['pct', 'brightness', 'dim'];
const volumePossibleSets = ['Volume', 'volume', 'GroupVolume'];
const temperaturePossibleSets = ['desired-temp'];
const Utemperature = ['temperature', 'measured-temp', 'desired-temp', 'degrees', 'box_cputemp', 'temp_c', 'cpu_temp', 'cpu_temp_avg'];
const buttonPossibleSets = ['noArg'];
const levelPossibleSets = ['slider'];
const rgbPossibleSets = ['rgb'];
let logCheckObject = true;
let logUpdateChannel = true;
let logCreateChannel = true;
let logDeleteChannel = true;
let logEventIOB = true;
let logEventFHEM = false;
let logEventFHEMglobal = true;
let logEventFHEMreading = false;
let logEventFHEMstate = false;
let logUnhandledEventFHEM = true;
const ts_update = new Date().getTime();

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', callback => {
    try {
        adapter.setState('info.connection', false, true);
        if (telnetOut) {
            telnetOut.destroy();
            telnetOut = null;
        }
        if (telnetIn) {
            telnetIn.destroy();
            telnetIn = null;
        }
        callback();
    } catch (e) {
        callback();
    }
});

// is called if a subscribed state changes
adapter.on('stateChange', (id, state) => {
    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        if (!connected) {
            adapter.log.warn('Cannot send command to "' + id + '", because not connected');
            return;
        }
        if (id === adapter.namespace + '.info.resync') {
            queue.push({
                command: 'resync'
            });
            processQueue();
        } else if (fhemObjects[id] || id === adapter.namespace + '.info.Commands.sendFHEM' || id.indexOf(adapter.namespace + '.info.Settings.log') !== -1 ) {
            adapter.log.debug('in: ' + id + ' ' + state.val);
            queue.push({
                command: 'write',
                id: id,
                val: state.val
            });
            processQueue();
        }
    }
});

// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', obj => {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');
            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', main);

//========================================================================================================================================== start
function getUnit(name) {
    //adapter.log.debug('[getUnit] ' + name);
    name = name.toLowerCase();
    if (Utemperature.indexOf(name) !== -1) {
        return '°C';
    } else if (name.indexOf('humidity') !== -1) {
        return '%';
    } else if (name.indexOf('pressure') !== -1) {
        return 'hPa';
    } else if (name.indexOf('speed') !== -1) {
        return 'kmh';
    }
    return undefined;
}

//--------------------------------------------------------------------------------------
function parseEvent(event,anz) {
    if (!event) return;
    if (logEventFHEM === true) adapter.log.info('event (FHEM) "' + event + '"');
    // Sonos special
    if (event.indexOf('display_covertitle') !== -1) return;

    let ts = undefined;
    if (event[4] === '-' && event[7] === '-') {
        ts = new Date(event.substring(0, 19)).getTime();
        event = event.substring(20);
    }

    let name;
    let id;
    let val;
    const pos = event.indexOf(':');
    let parts = event.split(' ');
    // ignore Reading?
    if (parts[2] && parts[2].substr(parts[2].length-1)===':' && ignoreReadings.indexOf(parts[2].substr(0,parts[2].length-1)) !== -1) return;
    // No cannel for event and not global?
    if (!fhemObjects[adapter.namespace + '.' + parts[1]] && parts[1] !== 'global') return;
    // Global global ?
    if (parts[0] === 'Global' && parts[1] === 'global') {
       // Global global DEFINED ?
       if (parts[2] === 'DEFINED') {
           if (logEventFHEMglobal === true) adapter.log.info('event FHEM(g) "' + event + '"');
           queue.push({
                command: 'meta',
                name: parts[3],
                attr: 'state',
                val: 'no',
                event: event
           });
           processQueue();
           return;
       }
       // No channel for event and not room?
       if (!fhemObjects[adapter.namespace + '.' + parts[3]] && parts[4] !== 'room') return;
       // Global global ATTR ?
       if (parts[2] === 'ATTR' && allowedAttributes.indexOf(parts[4]) !== -1) {
           if (logEventFHEMglobal === true) adapter.log.info('event FHEM(g) "' + event + '"');
           queue.push({
                command: 'meta',
                name: parts[3],
                attr: 'no',
                val: parts[4],
                event: event
           });
           processQueue();
           return;
       }
       // Global global DELETEATTR ?
       if (parts[2] === 'DELETEATTR' && allowedAttributes.indexOf(parts[4]) !== -1) {
           if (logEventFHEMglobal === true) adapter.log.info('event FHEM(g) "' + event + '"');
           if (parts[4] === 'room' && iobroker === true) {
                  unusedObjects(parts[3] + '.*')
              } else {
                  unusedObjects(parts[3] + '.Attributes.' + parts[4]);
              }
           return;
       }
       // Global global DELETED ?
       if (parts[2] === 'DELETED') {
           if (logEventFHEMglobal === true) adapter.log.info('event FHEM(g) "' + event + '"');
           unusedObjects(parts[3] + '.*');
           return;
       }
       if (logUnhandledEventFHEM === true) adapter.log.warn ('unhandled event FHEM(g) "' + event + '" > jsonlist2');
       queue.push({
           command: 'meta',
           name: parts[3],
           attr: 'no',
           val: parts[4],
           event: event
       });
       processQueue();
       return;
    }
     
    // state?
    if (pos === -1) {
        val = convertFhemValue(event.substring(parts[0].length + parts[1].length + 2));
        id = adapter.namespace + '.' + parts[1].replace(/\./g, '_') + '.state';
        if (fhemObjects[id]) {
            adapter.setForeignState(id, {
                val: val,
                ack: true,
                ts: ts
            });
            // special for switch
            let id_switch = adapter.namespace + '.' + parts[1].replace(/\./g, '_') + '.state_switch';
            if (fhemObjects[id_switch] && (parts[2] == 'on' || parts[2] == 'off')) {
                    adapter.setState(id_switch,convertFhemValue(parts[2]),true);
            }
            // special for ZWave dim
            if (parts[0] == 'ZWave' && parts[2] == 'dim') {
                let zwave = parts[0] + ' ' + parts[1] + ' ' + parts[2] +': ' + parts[3];
                adapter.log.info('event (Create4ZWave) "' + zwave + '"');
                parseEvent(zwave);
            }
            if (logEventFHEMstate === true) adapter.log.info('event FHEM(s) "' + event + '" > ' + id + '  ' + val);
        } else {
            adapter.log.warn('[parseEvent] no object(S): "' + event + '" > ' + id + ' = ' + val);
            queue.push({
                command: 'meta',
                name: parts[1],
                attr: 'state',
                val: val,
                event: event
            });
            processQueue();
        }
        return;
    }

    // reading or state?
    if (pos !== -1) {
        var stelle =  event.substring(parts[0].length + parts[1].length + parts[2].length + 1);
        var typ;
        // reading
        if (stelle.indexOf(':') === 0) {
            // special?
            if (parts[0] === 'at' && parts[2] === 'Next:' || parts[2] === 'T:' || parts[0] === 'FRITZBOX' && parts[2] === 'WLAN:' || parts[0] === 'CALVIEW' && parts[2] === 't:') {
            val = convertFhemValue(event.substring(parts[0].length + parts[1].length + 2));
            id = adapter.namespace + '.' + parts[1].replace(/\./g, '_') + '.state';
            typ = 'state';
            } else {
            name = event.substring(0, pos);
            parts = name.split(' ');
            id = adapter.namespace + '.' + parts[1].replace(/\./g, '_') + '.' + parts[2].replace(/\./g, '_');
            val = convertFhemValue(event.substring(parts[0].length + parts[1].length + parts[2].length + 4));
            // rgb? insert #
            if (parts[2] === 'rgb') val = '#' + val;
            // temperature?
            if (Utemperature.indexOf(parts[2]) !== -1) {val = parseFloat(val)}
            typ = 'reading';
            }
        }
        // state
        if (stelle.indexOf(':') !== 0) {
            val = convertFhemValue(event.substring(parts[0].length + parts[1].length + 2));
            id = adapter.namespace + '.' + parts[1].replace(/\./g, '_') + '.state';
            typ = 'state';
        }
        //
        if (!fhemObjects[id]) {
             if (logUnhandledEventFHEM === true) adapter.log.warn('unhandled event FHEM "' + event + '" > jsonlist2');
             if (parts[1] !== lastNameQueue || parts[1] === lastNameQueue && lastNameTS + 2000 < new Date().getTime()) {
                 queue.push({
                    command: 'meta',
                    name: parts[1],
                    attr: parts[2],
                    val: val,
                    event: event
                 });
                 processQueue();
                 lastNameQueue = parts[1];
                 lastNameTS = new Date().getTime();
            }
        }
        //
        if (fhemObjects[id]) {
            if (logEventFHEMreading === true && typ === 'reading') adapter.log.info('event FHEM(r) "' + event + '" > ' + id +' ' + val);
            if (logEventFHEMstate === true && typ === 'state') adapter.log.info('event FHEM(s) "' + event + '" > ' + id +' ' + val);
            adapter.setForeignState(id, {
                val: val,
                ack: true,
                ts: ts
            });
        }
        return;
   }
   adapter.log.warn('[parseEvent] no action ' + event);
}

//--------------------------------------------------------------------------------------
function syncStates(states, cb) {
    if (!states || !states.length) {
        adapter.log.debug('end [syncStates]');
        cb();
        return;
    }
    const state = states.shift();
    const id = state.id;
    delete state.id;

    adapter.setForeignState(id, state, err => {
        if (err) adapter.log.error('[syncStates] ' + err);
        setImmediate(syncStates, states, cb);
    });
}

//--------------------------------------------------------------------------------------
function syncObjects(objects, cb) {
    if (!objects || !objects.length) {
        adapter.log.debug('end [syncObjects]');
        cb();
        return;
    }
    const obj = objects.shift();
    fhemObjects[obj._id] = obj;
    adapter.getForeignObject(obj._id, (err, oldObj) => {
        if (err) adapter.log.error('[syncObjects] ' + err);

        if (!oldObj) {
            if (obj.type === 'channel') adapter.log.info('Create channel ' + obj._id + ' | ' + obj.common.name);
            adapter.setForeignObject(obj._id, obj, err => {
                if (err) adapter.log.error('[syncObjects] ' + err);
                setImmediate(syncObjects, objects, cb);
            });
        } else {
            if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native || obj.common.name !== oldObj.common.name)) {
                oldObj.native = obj.native;
                oldObj.common.name = obj.common.name;
                if (obj.type === 'channel' && logUpdateChannel === true) adapter.log.info('Update channel ' + obj._id + ' | ' + oldObj.common.name);
                adapter.setForeignObject(obj._id, oldObj, err => {
                    if (err) adapter.log.error('[syncObjects] ' + err);
                    setImmediate(syncObjects, objects, cb);
                });
            } else {
                setImmediate(syncObjects, objects, cb);
            }
        }
    });

}

//--------------------------------------------------------------------------------------
function syncRoom(room, members, cb) {
    adapter.log.debug('[syncRoom] (' + room + ') ' + members);
    adapter.getForeignObject('enum.rooms.' + room, (err, obj) => {
        if (!obj) {
            obj = {
                _id: 'enum.rooms.' + room,
                type: 'enum',
                common: {
                    name: room,
                    members: members
                },
                native: {}
            };
            adapter.log.debug('update' + obj._id + '"');
            adapter.setForeignObject(obj._id, obj, err => {
                if (err) adapter.log.error('[syncRoom] ' + err);
                cb();
            });
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            let changed = false;
            for (let m = 0; m < members.length; m++) {
                if (obj.common.members.indexOf(members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(members[m]);
                }
            }
            if (changed) {
                adapter.log.debug('update "' + obj._id + '"');
                adapter.setForeignObject(obj._id, obj, err => {
                    if (err) adapter.log.error('[syncRoom] ' + err);
                    cb();
                });
            } else {
                cb();
            }
        }
    });
}

//--------------------------------------------------------------------------------------
function syncRooms(rooms, cb) {
    for (const r in rooms) {
        if (!rooms.hasOwnProperty(r)) continue;
        if (rooms[r]) {
            syncRoom(r, rooms[r], () => setImmediate(syncRooms, rooms, cb));
            rooms[r] = null;
            return;
        }
    }
    if (cb) cb();
}

//--------------------------------------------------------------------------------------
function syncFunction(funktion, members, cb) {
    adapter.log.debug('[syncFunction] (' + funktion + ') ' + members);
    adapter.getForeignObject('enum.functions.' + funktion, function(err, obj) {
        if (!obj) {
            obj = {
                _id: 'enum.functions.' + funktion,
                type: 'enum',
                common: {
                    name: funktion,
                    members: members
                },
                native: {}
            };
            adapter.log.debug('create' + obj._id + '"');
            adapter.setForeignObject(obj._id, obj, function(err) {
                if (err) adapter.log.error('[syncFunction] ' + err);
                cb();
            });
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            let changed = false;
            for (let m = 0; m < members.length; m++) {
                if (obj.common.members.indexOf(members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(members[m]);
                }
            }
            if (changed) {
                adapter.log.debug('update "' + obj._id + '"');
                adapter.setForeignObject(obj._id, obj, function(err) {
                    if (err) adapter.log.error('[syncFunction] ' + err);
                    cb();
                });
            } else {
                cb();
            }
        }
    });

}

//--------------------------------------------------------------------------------------
function syncFunctions(functions, cb) {
    for (const f in functions) {
        if (!functions.hasOwnProperty(f)) continue;
        if (functions[f]) {
            syncFunction(f, functions[f], () => setImmediate(syncFunctions, functions, cb));
            functions[f] = null;
            return;
        }
    }
    if (cb) cb();
}

//--------------------------------------------------------------------------------------
function myObjects(cb) {
    adapter.log.debug ('[myObjects] start');
    adapter.log.info('check objects ' + adapter.namespace + '.info');
    const newPoints =[
        // info.Command
        {id: 'Commands.lastCommand',name: 'Last command to FHEM', type: 'string', read: true, write: false, role: 'value'},
        {id: 'Commands.sendFHEM',name: 'Befehlszeile an FHEM', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Commands.resultFHEM',name: 'Antwort von FHEM', type: 'string', read: true, write: false, role: 'value'},
        // info.Info
        {id: 'Info.NumberObjects',name: 'Number of objects FHEM', type: 'number', read: true, write: false, role: 'value'},
        {id: 'Info.roomioBroker',name: 'Room ioBroker exist', type: 'boolean', read: true, write: false, role: 'value'},
        /* coming soon
        // info.Configurations
        {id: 'Configurations.allowedAttributes',name: 'Allowed Attributes (need room)', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.allowedInternals',name: 'Allowed Internals (need TYPE)', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.ignoreReadings',name: 'Ignore Readings', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.ignorePossibleSets',name: 'Ignore PossibleSets', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.ignoreObjectsInternalsTYPE',name: 'ignore Internals TYPE', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.ignoreObjectsInternalsNAME',name: 'ignore Internals Name', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.ignoreObjectsAttributesroom',name: 'ignore Attributes room', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.RdimPossibleSets',name: 'role = level.dimmer', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.RvolumePossibleSets',name: 'role = level.volume', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.RtemperaturePossibleSets',name: 'role = level.temperature', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.RbuttonPossibleSets',name: 'role = button', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.RlevelPossibleSets',name: 'role = level.xxx', type: 'string', read: true, write: true, role: 'state'},
        {id: 'Configurations.Utemperature',name: 'Unit C & role = value.temperature (nur Kleinbuchstaben)', type: 'string', read: true, write: true, role: 'state'},
        */
        // info.Settings
        {id: 'Settings.logCheckObject',name: 'Log Info Check channel', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logUpdateChannel',name: 'Log Info Update channel', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logCreateChannel',name: 'Log Info Create channel', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logDeleteChannel',name: 'Log Info Delete channel', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logUpdateChannel',name: 'Log Update channel', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logEventIOB',name: 'Log event ioBroker', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logEventFHEM',name: 'Log event FHEM telnet in', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logEventFHEMglobal',name: 'Log event FHEM Global', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logEventFHEMreading',name: 'Log event FHEM Reading', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logEventFHEMstate',name: 'Log event FHEM state', type: 'boolean', read: true, write: true, role: 'switch'},
        {id: 'Settings.logUnhandledEventFHEM',name: 'Log unhandled event FHEM', type: 'boolean', read: true, write: true, role: 'switch'},
    ];
    for (let i = 0; i < newPoints.length; i++) {
         const id = adapter.namespace + '.info.' +  newPoints[i].id;
         adapter.log.debug ('[myObjects] ' + i + ' ' + id);
         adapter.setObjectNotExists(id,{
             type: 'state',
             common: {
                 name:  newPoints[i].name,
                 type:  newPoints[i].type,
                 read:  newPoints[i].read,
                 write: newPoints[i].write,
                 role:  newPoints[i].role
            },
            native: {}
        });
    }
    cb();
}

//--------------------------------------------------------------------------------------
function getSetting(id, setting, callback) {
    adapter.log.debug ('[getSetting] ' + id + ' ' + setting);
    adapter.getState (id,function(err,obj) {
         if (err) adapter.log.error ('getSetting: ' + err);
         if (obj) {
             adapter.log.info('> ' + id + ' = ' + obj.val);
             callback(obj.val);
         } else  {
             adapter.setState(id,setting,true);
             adapter.log.info('> ' + id + ' = ' + setting);
             callback(setting);
         }
   });
}

//--------------------------------------------------------------------------------------
function getSettings(mode, cb) {
    adapter.log.debug ('[getSettings] ' + mode);
    /* coming soon
    if (mode === 'config' || mode === 'all') {
          adapter.log.info('check ' + adapter.namespace + '.' + 'info.Configurations');
          getSetting('info.Configurations.allowedAttributes', allowedAttributes, function(wert){allowedAttributes=JSON.parse(wert)});
          getSetting('info.Configurations.allowedInternals', allowedInternals, function (wert){allowedInternals=JSON.parse(wert)});;
          getSetting('info.Configurations.ignoreReadings', ignoreReadings, function (wert){ignoreReadings=JSON.parse(wert)});
          getSetting('info.Configurations.ignorePossibleSets', ignorePossibleSets, function (wert){ignorePossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.ignoreObjectsInternalsTYPE', ignoreObjectsInternalsTYPE, function (wert){ignoreObjectsInternalsTYPE=JSON.parse(wert)});
          getSetting('info.Configurations.ignoreObjectsInternalsNAME', ignoreObjectsInternalsNAME, function (wert){ignoreObjectsInternalsNAME=JSON.parse(wert)});
          getSetting('info.Configurations.ignoreObjectsAttributesroom', ignoreObjectsAttributesroom, function (wert){ignoreObjectsAttributesroom=JSON.parse(wert)});
          getSetting('info.Configurations.RdimPossibleSets', dimPossibleSets, function (wert){dimPossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.RvolumePossibleSets', volumePossibleSets, function (wert){volumePossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.RtemperaturePossibleSets', temperaturePossibleSets, function (wert){temperaturePossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.RlevelPossibleSets', levelPossibleSets, function (wert){levelPossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.RbuttonPossibleSets', buttonPossibleSets, function (wert){buttonPossibleSets=JSON.parse(wert)});
          getSetting('info.Configurations.Utemperature', Utemperature, function (wert){Utemperature=JSON.parse(wert)});
    }
    */
    if (mode === 'settings' || mode === 'all') {
         adapter.log.info('check ' + adapter.namespace + '.' + 'info.Settings');
         getSetting('info.Settings.logCheckObject', logCheckObject, function (wert){logCheckObject=wert});
         getSetting('info.Settings.logUpdateChannel', logUpdateChannel, function (wert){logUpdateChannel=wert});
         getSetting('info.Settings.logCreateChannel', logCreateChannel, function (wert){logCreateChannel=wert});
         getSetting('info.Settings.logDeleteChannel', logDeleteChannel, function (wert){logDeleteChannel=wert});
         getSetting('info.Settings.logEventIOB', logEventIOB, function (wert){logEventIOB=wert});
         getSetting('info.Settings.logEventFHEM', logEventFHEM, function (wert){logEventFHEM=wert});
         getSetting('info.Settings.logEventFHEMglobal', logEventFHEMglobal, function (wert){logEventFHEMglobal=wert});
         getSetting('info.Settings.logEventFHEMreading', logEventFHEMreading, function (wert){logEventFHEMreading=wert});
         getSetting('info.Settings.logEventFHEMstate', logEventFHEMstate, function (wert){logEventFHEMstate=wert});
         getSetting('info.Settings.logUnhandledEventFHEM', logUnhandledEventFHEM, function (wert){logUnhandledEventFHEM=wert});

    }
    if (cb) cb();
}

//--------------------------------------------------------------------------------------
function parseObjects(objs, cb) {
    adapter.log.debug ('[parseObjects]');
    const rooms = {};
    //
    const objects = [];
    const states = [];
    let id;
    let obj;
    let name;
    let suche = 'no';

    if (firstRun == true) {
        adapter.setState('info.Info.NumberObjects', objs.length, true);
        adapter.log.info('> info.Info.NumberObjects = ' + objs.length);
        //room ioBroker?
        for (let i = 0; i < objs.length; i++) {
            try {
                if (objs[i].Attributes.room) {
                    suche = objs[i].Attributes.room;
                }
                if (suche.indexOf('ioBroker') !== -1) {
                    iobroker = true;
                    continue;
                }
            } catch (err) {
                     adapter.log.error('[parseObjects] Cannot check room of object: ' + JSON.stringify(objs[i]));
                     adapter.log.error('[parseObjects] Cannot check room of object: ' + err);
            }
        }
        adapter.setState('info.Info.roomioBroker', iobroker, true);
        adapter.log.info('> info.Info.roomioBroker = ' + iobroker);
        //temporary
        adapter.log.info('> allowedAttributes = ' + allowedAttributes);
        adapter.log.info('> allowedInternals = ' + allowedInternals);
        adapter.log.info('> ignoreReadings = ' + ignoreReadings);
        adapter.log.info('> ignorePossibleSets = ' + ignorePossibleSets);
        adapter.log.info('> ignoreObjectsInternalsTYPE = ' + ignoreObjectsInternalsTYPE);
        adapter.log.info('> ignoreObjectsInternalsNAME = ' + ignoreObjectsInternalsNAME);
        adapter.log.info('> ignoreObjectsAttributesroom = ' + ignoreObjectsAttributesroom);
        adapter.log.info('> RdimPossibleSets = ' + dimPossibleSets);
        adapter.log.info('> RvolumePossibleSets = ' + volumePossibleSets);
        adapter.log.info('> RtemperaturePossibleSets = ' + temperaturePossibleSets);
        adapter.log.info('> RlevelPossibleSets = ' + levelPossibleSets);
        adapter.log.info('> RbuttonPossibleSets = ' + buttonPossibleSets);
        adapter.log.info('> Utemperature = ' + Utemperature);
    }
    
    for (let i = 0; i < objs.length; i++) {
        try {
            //ignore Internals TYPE,NAME & Attributtes room
            if (ignoreObjectsInternalsTYPE.indexOf(objs[i].Internals.TYPE) !== -1) {
                adapter.log.info('> ignore TYPE: ' + objs[i].Name);
                continue;
            }
            if (ignoreObjectsInternalsNAME.indexOf(objs[i].Internals.NAME) !== -1) {
                adapter.log.info('> ignore NAME: ' + objs[i].Name);
                continue;
            }
            if (ignoreObjectsAttributesroom.indexOf(objs[i].Attributes.room) !== -1) {
                adapter.log.info('> ignore room: ' + objs[i].Name);
                continue;
            }
            
            let isOn = false;
            let isOff = false;
            let setStates = {};
            let searchRoom = 'no';
            let alias =  objs[i].Name;
            let Funktion = 'no';
            name = objs[i].Name.replace(/\./g, '_');
            id = adapter.namespace + '.' + name;
            
            if (objs[i].Attributes.room) searchRoom = objs[i].Attributes.room;
            if (objs[i].Attributes && objs[i].Attributes.room === 'hidden' || searchRoom.indexOf('ioBroker') === -1 && iobroker === true) {
                if (synchro != true) unusedObjects(name + '.*', cb);
                continue;
            }
            //alias?
            if (objs[i].Attributes && objs[i].Attributes.alias) {
                alias =  objs[i].Attributes.alias;
            }
            
            objects.push({
                _id: id,
                type: 'channel',
                common: {
                    name: alias
                },
                native: objs[i]
            });
            
            //Function?
            if (objs[i].Internals.TYPE === 'HUEDevice') {
                Funktion =  'light';
            }
            //if (objs[i].Internals.TYPE === 'SONOSPLAYER') {
            //    Funktion =  'audio';
            //}
            if (objs[i].Attributes.model === 'HM-CC-RT-DN') {
                Funktion =  'heating';
            }
            //if (objs[i].Internals.TYPE === 'Weather') {
            //    Funktion =  'weather';
            //}
            if (Funktion !== 'no') {
                setFunction(id,Funktion,name);
            }

            if (logCheckObject === true) adapter.log.info('check channel ' + id + ' | name: ' + alias + ' | room: ' + objs[i].Attributes.room + ' | function: ' + Funktion + ' | ' + ' '+ (i + 1) + '/' + objs.length);

            //Rooms
            if (objs[i].Attributes && objs[i].Attributes.room) {
                const rrr = objs[i].Attributes.room.split(',');
                for (let r = 0; r < rrr.length; r++) {
                    rrr[r] = rrr[r].trim();
                    rooms[rrr[r]] = rooms[rrr[r]] || [];
                    rooms[rrr[r]].push(adapter.namespace + '.' + name);
                }
            }

            //-----------------------------------------
            if (objs[i].Attributes) {
                let alias = name;
                for (const attr in objs[i].Attributes) {
                    id = adapter.namespace + '.' + name + '.' + 'Attributes.' + attr.replace(/\./g, '_');
                    // allowed Attributes?
                    if (allowedAttributes.indexOf(attr) === -1) continue;
                    const val = objs[i].Attributes[attr];
                    if (attr === 'alias') {
                        alias = val;
                    }
                    
                    obj = {
                        _id: id,
                        type: 'state',
                        common: {
                            name: objs[i].Name + ' ' + attr,
                            type: 'string',
                            read: true,
                            write: true,
                            role: 'state.' + attr
                        },
                        native: {
                            Name: objs[i].Name,
                            Attribute: attr,
                            Attributes: true
                        }
                    };
                    obj.native.ts = new Date().getTime();
                    objects.push(obj);
                    states.push({
                        id: obj._id,
                        val: val,
                        ts: new Date().getTime(),
                        ack: true
                    });
                }
            }

            //-----------------------------------------
            if (objs[i].Internals) {
                for (const attr in objs[i].Internals) {
                    // allowed Internals?
                    if (!objs[i].Internals.hasOwnProperty(attr) || allowedInternals.indexOf(attr) === -1) continue;
                    id = adapter.namespace + '.' + name + '.' + 'Internals.' + attr.replace(/\./g, '_');
                    const val = objs[i].Internals[attr];
                    obj = {
                        _id: id,
                        type: 'state',
                        common: {
                            name: objs[i].Name + ' ' + attr,
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'value' + '.' + attr
                        },
                        native: {
                            Name: objs[i].Name,
                            Attribute: attr,
                            Internals: true
                        }
                    };
                    obj.native.ts = new Date().getTime();
                    objects.push(obj);
                    states.push({
                        id: obj._id,
                        val: val,
                        ts: new Date().getTime(),
                        ack: true
                    });
                }
            }

            //-----------------------------------------
            if (objs[i].PossibleSets && objs[i].PossibleSets.length > 1) {
                const attrs = objs[i].PossibleSets.split(' ');
                for (let a = 0; a < attrs.length; a++) {
                    if (!attrs[a]) continue;
                    const parts = attrs[a].split(':');
                    Funktion = 'no';
                    // ignore PossibleSets
                    if (ignorePossibleSets.indexOf(parts[0]) !== -1) continue;
                    const stateName = parts[0].replace(/\./g, '_');
                    id = adapter.namespace + '.' + name + '.' + stateName;

                    if (parts[0] === 'off') isOff = true;
                    if (parts[0] === 'on') isOn = true;

                    obj = {
                        _id: id,
                        type: 'state',
                        common: {
                            name: objs[i].Name + ' ' + parts[0],
                            type: 'string',
                            read: false,
                            write: true,
                            role: 'state.' + parts[0]
                        },
                        native: {
                            Name: objs[i].Name,
                            Attribute: parts[0],
                            possibleSets: true
                        }
                    };

                    if (parts[1]) {
                        if (parts[1].indexOf('noArg') !== -1) {
                            obj.common.type = 'boolean';
                            obj.common.role = 'button.' + parts[0];
                        }
                        if (parts[1].indexOf('slider') !== -1) {
                            const _slider = parts[1].split(',');
                            obj.common.min = _slider[1];
                            obj.common.max = _slider[3];
                            obj.common.type = 'number';
                            obj.common.role = 'level.' + parts[0];
                        }
                    }

                    if (temperaturePossibleSets.indexOf(parts[0]) !== -1) {
                        obj.common.type = 'number';
                        obj.common.min = '5';
                        obj.common.max = '30';
                        obj.common.role = 'level.temperature';
                        obj.common.unit = '°C';
                        obj.native.level_temperature = true;
                        if (adapter.namespace === 'fhem.0') {
                            obj.common.smartName = {
                                'de': alias
                            };
                        }
                    }

                    if (dimPossibleSets.indexOf(parts[0]) !== -1) {
                        obj.common.type = 'number';
                        obj.common.min = '0';
                        obj.common.max = '100';
                        obj.common.role = 'level.dimmer';
                        obj.common.unit = '%';
                        obj.native.level_dimmer = true;
                        if (adapter.namespace === 'fhem.0') {
                            obj.common.smartName = {
                                'de': alias
                            };
                        }
                    }

                    if (volumePossibleSets.indexOf(parts[0]) !== -1) {
                        //Funktion = 'audio';
                        obj.common.type = 'number';
                        obj.common.min = '0';
                        obj.common.max = '100';
                        obj.common.role = 'level.volume';
                        obj.common.unit = '%';
                        obj.native.volume = true;
                        if (parts[0].indexOf('Group') != -1) obj.common.role = 'level.volume.group';
                        if (adapter.namespace == 'fhem.0') {
                            var smartN = {
                                'de': alias
                            };
                            obj.common.smartName = smartN;
                        }
                    }
                    
                    if (rgbPossibleSets.indexOf(parts[0]) !== -1) {
                        obj.common.type = 'number';
                        obj.common.role = 'level.color.rgb';
                        obj.native.rgb = true;
                        if (adapter.namespace == 'fhem.0') {
                            var smartN = {
                                'de': alias
                            };
                            obj.common.smartName = smartN;
                        }
                    }

                    if (parts[0].indexOf('RGB') !== -1) {
                        obj.common.role = 'light.color.rgb';
                        obj.native.rgb = true;
                    }
                    if (parts[0].indexOf('HSV') !== -1) {
                        obj.common.role = 'light.color.hsv';
                        obj.native.hsv = true;
                    }

                    obj.native.ts = new Date().getTime();
                    objects.push(obj);
                    setStates[stateName] = obj;
                    
                    if (logCheckObject === true && obj.common.role.indexOf('state') === -1) adapter.log.info('> role = ' +  obj.common.role + ' | ' + id);
                    //Function?
                    if (Funktion !== 'no') {
                           setFunction(id,Funktion,name);
                    }
                }
            }

            //-----------------------------------------
            if (objs[i].Readings) {
                for (const attr in objs[i].Readings) {
                    if (!objs[i].Readings.hasOwnProperty(attr)) continue;
                    // ignore Readings ?
                    if (ignoreReadings.indexOf(attr) !== -1) continue;
                    const stateName = attr.replace(/\./g, '_');
                    id = adapter.namespace + '.' + name + '.' + stateName;
                    let combined = false;
                    // PossibleSets?
                    if (setStates[stateName]) {
                        combined = true;
                        obj = setStates[stateName];
                        obj.common.read = true;
                    } else {
                        obj = {
                            _id: id,
                            type: 'state',
                            common: {
                                name: objs[i].Name + ' ' + attr,
                                type: 'string',
                                read: true,
                                write: false,
                                unit: getUnit(attr)
                            },
                            native: {
                                Name: objs[i].Name,
                                Attribute: attr,
                                Readings: true
                            }
                        };
                    }

                    if (objs[i].Readings[attr]) {
                        Funktion = 'no';
                        let val = convertFhemValue(objs[i].Readings[attr].Value);
                        obj.common.type = obj.common.type || typeof val;
                        obj.common.role = obj.common.role || 'value' + '.' + attr;

                        // detect temperature
                        if (obj.common.unit === '°C' && combined === false) {
                            obj.native.temperature = true;
                            Funktion = 'temperature';
                            obj.common.type = 'number';
                            obj.common.role = 'value.temperature';
                            val = parseFloat(val);
                        }
                        // detect state
                        if (attr === 'state') {
                            obj.common.write = true;
                            obj.common.role = 'state';
                        }
                        // detect on/off state (switch)
                        if (isOff === true && isOn === true && attr === 'state') {
                            obj.native.onoff = true;
                            Funktion = 'switch';
                            let obj_switch = {
                                _id: adapter.namespace + '.' + name + '.state_switch',
                                type: 'state',
                                common: {
                                    name:   objs[i].Name + ' ' + 'state_switch',
                                    type:  'boolean',
                                    read:  true,
                                    write: true,
                                    role:  'switch'
                                },
                                native: {
                                    Name: objs[i].Name,
                                    ts: new Date().getTime()
                               }
                            };
                            objects.push(obj_switch);
                            states.push({
                                id: obj_switch._id,
                                val: val,
                                ts: objs[i].Readings[attr].Time ? new Date(objs[i].Readings[attr].Time).getTime() : new Date().getTime(),
                                ack: true
                            });
                        }
                        obj.native.ts = new Date().getTime();
                        
                        states.push({
                            id: obj._id,
                            val: val,
                            ts: objs[i].Readings[attr].Time ? new Date(objs[i].Readings[attr].Time).getTime() : new Date().getTime(),
                            ack: true
                        });
                        if (!combined) {
                            objects.push(obj);
                            if (logCheckObject === true && obj.common.role.indexOf('value') === -1 && obj.common.role.indexOf('state') === -1 || (logCheckObject === true && obj.common.role.indexOf('value.temperature') !== -1)) adapter.log.info('> role = ' +  obj.common.role + ' | ' + id);
                            if (Funktion !== 'no') {
                                if (Funktion  === 'switch') id=adapter.namespace + '.' + name;
                                setFunction(id,Funktion,name);
                            }
                        }
                    }
                }
                delete objs[i].Readings;
            }
            setStates = null;
       } catch (err) {
            adapter.log.error('[parseObjects] Cannot process object: ' + JSON.stringify(objs[i]));
            adapter.log.error('[parseObjects] Cannot process object: ' + err);
       }
    }
    firstRun = false;
    adapter.log.debug('start [syncObjects]');
    adapter.log.debug('start [syncRooms]');
    adapter.log.debug('start [syncFunctions]');
    adapter.log.debug('start [syncStates]');
    syncObjects(objects, () => {
        syncRooms(rooms, () => {
            syncFunctions(functions, () => {
                syncStates(states, cb);
            });
        });
    });

}

//--------------------------------------------------------------------------------------
function startSync(cb) {
    adapter.log.debug('[startSync]');
    // send command JsonList2
    telnetOut.send('jsonlist2', (err, result) => {
        if (err) {
            adapter.log.error(err);
        }
        if (!connected) {
            adapter.log.info('Connected FHEM telnet ' + adapter.config.host + ':' + adapter.config.port);
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (result) {
            let objects = null;
            try {
                objects = JSON.parse(result)
            } catch (e) {
                adapter.log.error('[startSync] Cannot parse answer for jsonlist2: ' + e);
            }
            if (objects) {
                parseObjects(objects.Results, () => {
                    adapter.log.info('Synchronised FHEM!');
                    adapter.log.info('delete unused objects');
                    unusedObjects('*', cb);
                    synchro = false;
                    if (cb) {
                        cb();
                        cb = null;
                    }
                });

            } else if (cb) {
                cb();
                cb = null;
            }
        } else if (cb) {
            cb();
            cb = null;
        }
    });
}
//--------------------------------------------------------------------------------------
function setFunction(id,Funktion,name) {
    //if (id.indexOf('state') !== -1) id=id+'_switch'
    let fff = Funktion.split(',');
    for (let f = 0; f < fff.length; f++) {
        fff[f] = fff[f].trim();
        if (logCheckObject === true) adapter.log.info('> function = ' + fff[f] + ' | ' + id);
        functions[fff[f]] = functions[fff[f]] || [];
        functions[fff[f]].push(id);
    }
}

//--------------------------------------------------------------------------------------
function convertFhemValue(val) {
    val = val.trim();
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'on') return true;
    if (val === 'off') return false;
    const f = parseFloat(val);
    if (f == val) return f;
    return val;
}

//--------------------------------------------------------------------------------------
function readValue(id, cb) {
    telnetOut.send('get ' + fhemObjects[id].native.Name + ' ' + fhemObjects[id].native.Attribute, (err, result) => {
        if (err) adapter.log.error('readValue: ' + err);
        if (result) {
            result = convertFhemValue(result.substring(fhemObjects[id].native.Name.length + fhemObjects[id].native.Attribute + 5));
            if (result !== '') {
                adapter.setForeignState(id, result, true);
                adapter.log.info('readValue: ' + id + result);
            }
        }
        if (cb) cb();
    });
}

//--------------------------------------------------------------------------------------
function writeValueDo(id, val, cmd, mode) {
    adapter.log.debug('[writeValueDo] ' + id + ' ' + val + ' ' + cmd);
    if (logEventIOB === true) adapter.log.info('event ioBroker "' + id + ' ' + val + '" > ' + cmd);
    if (mode === 'command') adapter.setState('info.Commands.lastCommand', cmd, true);
    if (mode === 'iob') adapter.setState('info.Commands.lastCommand', cmd + ' / ' + id + ' ' + val, true);
    telnetOut.send(cmd, function(err, result) {
        if (err) adapter.log.error('[writeValueDo] ' + err);
        if (mode === 'command') {
           result = result.replace(/(\r\n)|(\r)|(\n)/g, '<br />');
           adapter.setState('info.Commands.resultFHEM', result, function(err) {
           if (err) adapter.log.error('[writeValueDo] ' + err);
           });
       }
    });
}

//--------------------------------------------------------------------------------------
function writeValue(id, val, cb) {
    adapter.log.debug('[writeValue] ' + id + ' ' + val);
    let cmd;
    //const valOrg = val;
    let parts;
    if (val === undefined || val === null) val = '';
    parts = id.split('.');
     // switch?
    if (id.indexOf('state_switch') !== -1) {
        if (val === '1' || val === 1 || val === 'on' || val === 'true' || val === true) val = 'on';
        if (val === '0' || val === 0 || val === 'off' || val === 'false' || val === false) val = 'off';
        cmd = 'set ' + fhemObjects[id].native.Name + ' ' + val;
        writeValueDo(id, val, cmd, 'iob');
        if (cb) cb();
        return;
    }
    // change settings?
    if (id.indexOf(adapter.namespace + '.info.Settings.') !== -1) {
        getSettings('settings');
        if (cb) cb();
        return;
    }
    // sendFHEM?
    if (id === adapter.namespace + '.info.Commands.sendFHEM') {
        cmd =  val;
        writeValueDo(id, val, cmd, 'command');
        if (cb) cb();
        return;
    }
    // attr?
    if (allowedAttributes.indexOf(parts[4]) !== -1) {
        cmd = 'attr ' + fhemObjects[id].native.Name + ' ' + parts[4] + ' ' + val;
        writeValueDo(id, val, cmd, 'iob');
        if (cb) cb();
        return;
    }
    // rgb?
    if (fhemObjects[id].native.Attribute === 'rgb') val = val.substring(1);
    // state?
    if (fhemObjects[id].native.Attribute === 'state') {
        if (val === '1' || val === 1 || val === 'on' || val === 'true' || val === true) val = 'on';
        if (val === '0' || val === 0 || val === 'off' || val === 'false' || val === false) val = 'off';
        cmd = 'set ' + fhemObjects[id].native.Name + ' ' + val;
    } else {
        cmd = 'set ' + fhemObjects[id].native.Name + ' ' + fhemObjects[id].native.Attribute + ' ' + val;
        // button?
        if(fhemObjects[id].common.role.indexOf('button') !== -1) {cmd = 'set ' + fhemObjects[id].native.Name + ' ' + fhemObjects[id].native.Attribute}
    }
    //writeValueDo(id, val_org, cmd, 'iob');
    if (logEventIOB === true) adapter.log.info('event ioBroker "' + id + ' ' + val + '" > ' + cmd);
    telnetOut.send(cmd, function(err, result) {
        if (err) adapter.log.error('[writeValue] ' + err);
        if (cb) cb();
    });
}

//--------------------------------------------------------------------------------------
function requestMeta(name, attr, value, event, cb) {
     adapter.log.info('check channel ' + name + ' > jsonlist2');
     // send command JsonList2
     telnetOut.send('jsonlist2 ' + name, (err, result) => {
        if (err) {
            adapter.log.error('[requestMeta] ' + err);
        }
        if (result) {
            let objects = null;
            try {
                objects = JSON.parse(result)
            } catch (e) {
                adapter.log.error('[requestMeta] Cannot parse answer for jsonlist2: ' + e);
            }
            if (objects) {
                parseObjects(objects.Results, () => {
                    if (cb) {
                        cb();
                        cb = null;
                    }
                });
            } else if (cb) {
                cb();
                cb = null;
            }
        } else if (cb) {
            cb();
            cb = null;
        }
    });
}

//--------------------------------------------------------------------------------------
function deleteChannel(name, cb) {
    adapter.log.debug ('[deleteChannel] ' + name);
    delete fhemObjects[adapter.namespace + '.' + name];
    adapter.deleteChannel(name, err => {
        if (err) {if (err !== 'Not exists') adapter.log.error('[deleteChannel] ' + name + ' ' + err)}
        if (cb) cb();
    });
}

//--------------------------------------------------------------------------------------
function deleteObject(name, cb) {
    adapter.log.debug('[deleteObject] ' + name);
    adapter.delObject(name, err => {
        if (err) {if (err !== 'Not exists') adapter.log.error('[deleteObject] ' + name + ' ' + err)}
        if (cb) cb();
    });
}

//--------------------------------------------------------------------------------------
function deleteState(name, cb) {
    adapter.log.debug('[deleteState] ' + name);
     adapter.delState(name, err => {
        if (err) {if (err !== 'Not exists') adapter.log.error('[deleteState] ' + name + ' ' + err)}
        if (cb) cb();
    });
}

//--------------------------------------------------------------------------------------
function unusedObjects(check, cb) {
    adapter.log.debug ('[unusedObjects] ' + check);
    let channel = 'no';
    adapter.getStates(check, (err, states) => {
        if (err) {
            adapter.log.error('[unusedObjects] ' + err);
        } else {
            for (const id in states) {
                if (!states.hasOwnProperty(id)) continue;
                adapter.getObject(id, (err, obj) => {
                    if (err) {
                        adapter.log.error('[unusedObjects] ' + err);
                    } else {
                        if (!obj) return;
                        const channelS = obj._id.split('.');
                        if (channelS[2] === 'info') return;
                        if (check === '*') {
                            if (obj.native.ts < ts_update || !obj.native.ts) {
                                if (channelS[3] === 'Internals' && channelS[4] === 'TYPE') {
                                    queueL.push({
                                        command: 'delChannel',
                                        name: channelS[2]
                                    });
                                    processQueueL();
                                }
                                queueL.push({
                                    command: 'delObject',
                                    name: obj._id
                                });
                                processQueueL();
                                queueL.push({
                                    command: 'delState',
                                    name: obj._id
                                });
                                processQueueL();
                            }
                        } else {
                            if (channelS[3] === 'Internals' && channelS[4] === 'TYPE') {
                                queueL.push({
                                    command: 'delChannel',
                                    name: channelS[2]
                                });
                                processQueueL();
                            }
                            delete fhemObjects[obj._id];
                            queueL.push({
                                command: 'delObject',
                                name: obj._id
                            });
                            processQueueL();
                            queueL.push({
                                command: 'delState',
                                name: obj._id
                            });
                            processQueueL();
                        }
                    }
                });
            }
        }
    });
    if (cb) cb();
}

//-------------------------------------------------------------------------------------------------------------------------------
function processQueue() {
    //adapter.log.debug ('[processQueue]');
    if (telnetOut.isCommandRunning() || !queue.length) return;
    const command = queue.shift();
    if (command.command === 'resync') {
        adapter.log.info('Start Resync FHEM');
        startSync(() => setImmediate(processQueue));
    } else if (command.command === 'read') {
        readValue(command.id, () => setImmediate(processQueue));
    } else if (command.command === 'write') {
        adapter.log.debug('[processQueue] ' + command.id + ' ' + command.val);
        writeValue(command.id, command.val, () => setImmediate(processQueue));
    } else if (command.command === 'meta') {
        requestMeta(command.name, command.attr, command.val, command.event, () => setImmediate(processQueue));
    } else {
        adapter.log.error('[processQueue] Unknown task: ' + command.command);
        setImmediate(processQueue);
    }
}

//-------------------------------------------------------------------------------------------------------------------------------
function processQueueL() {
    //adapter.log.debug ('[processQueueL]');
    if (!queueL.length) return;
    const command = queueL.shift();
    if (command.command === 'delObject') {
        deleteObject(command.name, () => setImmediate(processQueueL));
    } else if (command.command === 'delState') {
        deleteState(command.name, () => setImmediate(processQueueL));
    } else if (command.command === 'delChannel') {
        deleteChannel(command.name, () => setImmediate(processQueueL));
    } else {
        adapter.log.error('Unknown task: ' + command.command);
        setImmediate(processQueueL);
    }
}

//================================================================================================================================== end
function main() {
    adapter.log.debug ('[main]');
    adapter.config.host = adapter.config.host || '127.0.0.1';
    adapter.config.port = parseInt(adapter.config.port, 10) || 7072;
    adapter.config.reconnectTimeout = parseInt(adapter.config.reconnectTimeout, 10) || 30000;
    if (adapter.config.prompt === undefined) adapter.config.prompt = 'fhem>';

    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

    telnetIn = new Telnet({
        host: adapter.config.host,
        port: adapter.config.port,
        password: adapter.config.password,
        reconnectTimeout: adapter.config.reconnectTimeout,
        readOnly: true,
        prompt: adapter.config.prompt
    });
    telnetIn.on('data', data => parseEvent(data));
    //    parseEvent(data);
    //});

    telnetOut = new Telnet({
        host: adapter.config.host,
        port: adapter.config.port,
        password: adapter.config.password,
        reconnectTimeout: adapter.config.reconnectTimeout,
        prompt: adapter.config.prompt
    });

    telnetOut.on('ready', function() {
        if (!connected) {
            myObjects((cb) => {
                getSettings('all', (cb) => {
                    startSync(cb);
               });
           });
        }
    });
    telnetOut.on('end', () => {
        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });
    telnetOut.on('close', () => {
        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });
}
