import { Range } from 'vscode';
import { DCollection } from '../diagnostic';
import { isNumber } from 'util';
import { Moment } from 'moment';

export enum CheckState {
    Running = 'R',
    Success = 'S',
    Error = 'E',
    Stopped = 'X'
}

export enum CheckStatus {
    NotStarted,
    Starting,
    SanyParsing,
    SanyFinished,
    InitialStatesComputing,
    Checkpointing,
    CheckingLiveness,
    CheckingLivenessFinal,
    ServerRunning,
    WorkersRegistered,
    Finished
}

const STATUS_NAMES = new Map<CheckStatus, string>();
STATUS_NAMES.set(CheckStatus.NotStarted, 'Not started');
STATUS_NAMES.set(CheckStatus.Starting, 'Starting');
STATUS_NAMES.set(CheckStatus.SanyParsing, 'SANY parsing');
STATUS_NAMES.set(CheckStatus.SanyFinished, 'SANY finished');
STATUS_NAMES.set(CheckStatus.InitialStatesComputing, 'Computing initial states');
STATUS_NAMES.set(CheckStatus.Checkpointing, 'Checkpointing');
STATUS_NAMES.set(CheckStatus.CheckingLiveness, 'Checking liveness');
STATUS_NAMES.set(CheckStatus.CheckingLivenessFinal, 'Checking final liveness');
STATUS_NAMES.set(CheckStatus.ServerRunning, 'Master waiting for workers');
STATUS_NAMES.set(CheckStatus.WorkersRegistered, 'Workers connected');
STATUS_NAMES.set(CheckStatus.Finished, 'Finished');

const STATE_NAMES = new Map<CheckState, string>();
STATE_NAMES.set(CheckState.Running, 'Running');
STATE_NAMES.set(CheckState.Success, 'Success');
STATE_NAMES.set(CheckState.Error, 'Errors');
STATE_NAMES.set(CheckState.Stopped, 'Stopped');

/**
 * Statistics on initial state generation.
 */
export class InitialStateStatItem {
    constructor(
        readonly timeStamp: string,
        readonly diameter: number,
        readonly total: number,
        readonly distinct: number,
        readonly queueSize: number
    ) {}
}

/**
 * Statistics on coverage.
 */
export class CoverageItem {
    constructor(
        readonly module: string,
        readonly action: string,
        readonly filePath: string | undefined,
        readonly range: Range,
        readonly total: number,
        readonly distinct: number
    ) {}
}

export type ValueKey = string | number;

/**
 * Type of value change between two consecutive states.
 */
export enum Change {
    NOT_CHANGED = 'N',
    ADDED = 'A',
    MODIFIED = 'M',
    DELETED = 'D'
}

/**
 * Base class for values.
 */
export class Value {
    changeType = Change.NOT_CHANGED;

    constructor(
        readonly key: ValueKey,
        readonly str: string
    ) {}

    setModified(): Value {
        this.changeType = Change.MODIFIED;
        return this;
    }

    setAdded(): Value {
        this.changeType = Change.ADDED;
        return this;
    }

    setDeleted(): Value {
        this.changeType = Change.MODIFIED;
        return this;
    }
}

/**
 * A value that is represented by some variable name.
 */
export class NameValue extends Value {
    constructor(key: ValueKey, name: string) {
        super(key, name);
    }
}

/**
 * Value that is a collection of other values.
 */
export abstract class CollectionValue extends Value {
    readonly expandSingle = true;
    deletedItems: Value[] | undefined;

    constructor(key: ValueKey, readonly items: Value[], prefix: string, postfix: string, toStr?: (v: Value) => string) {
        super(key, makeCollectionValueString(items, prefix, postfix, ', ', toStr || (v => v.str)));
    }

    addDeletedItems(items: Value[]) {
        if (!items || items.length === 0) {
            return;
        }
        if (!this.deletedItems) {
            this.deletedItems = [];
        }
        const delItems = this.deletedItems;
        items.forEach(delItem => {
            const newValue = new Value(delItem.key, delItem.str);   // No need in deep copy here
            newValue.changeType = Change.DELETED;
            delItems.push(newValue);
        });
    }
}

/**
 * Represents a set: {1, "b", <<TRUE, 5>>}, {}, etc.
 */
export class SetValue extends CollectionValue {
    constructor(key: ValueKey, items: Value[]) {
        super(key, items, '{', '}');
    }

    setModified(): SetValue {
        super.setModified();
        return this;
    }
}

/**
 * Represents a sequence/tuple: <<1, "b", TRUE>>, <<>>, etc.
 */
export class SequenceValue extends CollectionValue {
    constructor(key: ValueKey, items: Value[]) {
        super(key, items, '<<', '>>');
    }
}

/**
 * Represents a structure: [a |-> 'A', b |-> 34, c |-> <<TRUE, 2>>], [], etc.
 */
export class StructureValue extends CollectionValue {
    constructor(key: ValueKey, items: Value[], preserveOrder?: boolean) {
        if (!preserveOrder) {
            items.sort(StructureValue.compareItems);
        }
        super(key, items, '[', ']', StructureValue.itemToString);
    }

    static itemToString(item: Value) {
        return `${item.key} |-> ${item.str}`;
    }

    static compareItems(a: Value, b: Value): number {
        if (a.key < b.key) {
            return -1;
        } else if (a.key > b.key) {
            return 1;
        }
        return 0;
    }

    setModified(): StructureValue {
        super.setModified();
        return this;
    }
}

/**
 * Represents a simple function: (10 :> TRUE), ("foo" :> "bar"), etc
 */
export class SimpleFunctionItem extends Value {
    constructor(
        key: ValueKey,
        readonly from: Value,
        readonly to: Value
    ) {
        super(key, `${from.str} :> ${to.str}`);
    }
}

/**
 * Represents a collection of merged simple functions: (10 :> TRUE),
 * ("foo" :> "bar" @@ "baz" => 31), etc
 */
export class SimpleFunction extends Value {
    readonly expandSingle = false;

    constructor(
        key: ValueKey,
        readonly items: SimpleFunctionItem[]
    ) {
        super(key, makeCollectionValueString(items, '(', ')', ' @@ ', (v => v.str)));
    }
}

/**
 * A state of a process in a particular moment of time.
 */
export class ErrorTraceItem {
    constructor(
        readonly num: number,
        readonly title: string,
        readonly module: string,
        readonly action: string,
        readonly filePath: string | undefined,
        readonly range: Range,
        readonly variables: StructureValue  // Variables are presented as items of a structure
    ) {}
}

/**
 * An output line produced by Print/PrintT along with the number of consecutive occurrences.
 */
export class OutputLine {
    count: number = 1;

    constructor(readonly text: string) {
    }

    increment() {
        this.count += 1;
    }
}

export enum ModelCheckResultSource {
    Process,    // The result comes from an ongoing TLC process
    OutFile     // The result comes from a .out file
}

/**
 * Represents the state of a TLA model checking process.
 */
export class ModelCheckResult {

    readonly stateName: string;
    readonly startDateTimeStr: string | undefined;
    readonly endDateTimeStr: string | undefined;
    readonly durationStr: string | undefined;
    readonly statusDetails: string | undefined;

    constructor(
        readonly source: ModelCheckResultSource,
        readonly showFullOutput: boolean,
        readonly state: CheckState,
        readonly status: CheckStatus,
        readonly processInfo: string | undefined,
        readonly initialStatesStat: InitialStateStatItem[],
        readonly coverageStat: CoverageItem[],
        readonly warnings: string[][],
        readonly errors: string[][],
        readonly errorTrace: ErrorTraceItem[],
        readonly sanyMessages: DCollection | undefined,
        readonly startDateTime: Moment | undefined,
        readonly endDateTime: Moment | undefined,
        readonly duration: number | undefined,
        readonly workersCount: number,
        readonly collisionProbability: string | undefined,
        readonly outputLines: OutputLine[]
    ) {
        this.stateName = getStateName(this.state);
        this.startDateTimeStr = dateTimeToStr(startDateTime);
        this.endDateTimeStr = dateTimeToStr(endDateTime);
        this.durationStr = durationToStr(duration);
        let statusDetails;
        switch (state) {
            case CheckState.Running:
                statusDetails = getStatusName(status);
                break;
            case CheckState.Success:
                statusDetails = collisionProbability
                    ? `Fingerprint collision probability: ${collisionProbability}`
                    : '';
                break;
            case CheckState.Error:
                statusDetails = `${errors.length} error(s)`;
                break;
        }
        this.statusDetails = statusDetails;
    }

    static createEmpty(source: ModelCheckResultSource): ModelCheckResult {
        return new ModelCheckResult(
            source, false, CheckState.Running, CheckStatus.Starting, undefined, [], [], [], [], [],
            undefined, undefined, undefined, undefined, 0, undefined, []);
    }
}

function getStateName(state: CheckState): string {
    const name = STATE_NAMES.get(state);
    if (typeof name !== 'undefined') {
        return name;
    }
    throw new Error(`Name not defined for check state ${state}`);
}

export function getStatusName(status: CheckStatus): string {
    const name = STATUS_NAMES.get(status);
    if (name) {
        return name;
    }
    throw new Error(`Name not defined for check status ${status}`);
}

/**
 * Recursively finds and marks all the changes between two collections.
 */
export function findChanges(prev: CollectionValue, state: CollectionValue): boolean {
    let pi = 0;
    let si = 0;
    let modified = false;
    const deletedItems = [];
    while (pi < prev.items.length && si < state.items.length) {
        const prevValue = prev.items[pi];
        const stateValue = state.items[si];
        if (prevValue.key > stateValue.key) {
            stateValue.changeType = Change.ADDED;
            modified = true;
            si += 1;
        } else if (prevValue.key < stateValue.key) {
            deletedItems.push(prevValue);
            pi += 1;
        } else {
            if (prevValue instanceof CollectionValue && stateValue instanceof CollectionValue) {
                modified = findChanges(prevValue, stateValue) || modified;
            } else if (prevValue.str !== stateValue.str) {
                stateValue.changeType = Change.MODIFIED;
                modified = true;
            }
            si += 1;
            pi += 1;
        }
    }
    for (; si < state.items.length; si++) {
        state.items[si].changeType = Change.ADDED;
        modified = true;
    }
    for (; pi < prev.items.length; pi++) {
        deletedItems.push(prev.items[pi]);
    }
    state.addDeletedItems(deletedItems);
    modified = modified || deletedItems.length > 0;
    if (modified) {
        state.changeType = Change.MODIFIED;
    }
    return modified;
}

function dateTimeToStr(dateTime: Moment | undefined): string {
    if (!dateTime) {
        return 'not yet';
    }
    return dateTime.format('HH:mm:ss (MMM D)');
}

function durationToStr(dur: number | undefined): string {
    if (!isNumber(dur)) {
        return '';
    }
    return dur + ' msec';
}

function makeCollectionValueString(
    items: Value[],
    prefix: string,
    postfix: string,
    delimiter: string,
    toStr: (v: Value) => string
) {
    // TODO: trim to fit into 100 symbols
    const valuesStr = items
        .filter(i => i.changeType !== Change.DELETED)
        .map(i => toStr(i))
        .join(delimiter);
    return prefix + valuesStr + postfix;
}
