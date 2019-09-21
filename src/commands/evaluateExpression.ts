import * as vscode from 'vscode';
import * as path from 'path';
import { replaceExtension, deleteDir, readFileLines, exists } from '../common';
import { SpecFiles, getEditorIfCanRunTlc, doCheckModel } from './checkModel';
import { createCustomModel } from './customModel';
import { ToolOutputChannel } from '../outputChannels';
import { ModelCheckResult, CheckState, SequenceValue } from '../model/check';
import { parseVariableValue } from '../parsers/tlcValues';

export const CMD_EVALUATE_SELECTION = 'tlaplus.evaluateSelection';

const EXPR_MARKER = '$!@$!@$!@$!@$!';

let lastEvaluatedExpression: string | undefined;
let outChannel: ToolOutputChannel | undefined;

/**
 * Evaluates the expression, currently selected in the active editor.
 */
export async function evaluateSelection(diagnostic: vscode.DiagnosticCollection, extContext: vscode.ExtensionContext) {
    const editor = getEditorIfCanRunTlc(extContext);
    if (!editor) {
        return;
    }
    const selRange = new vscode.Range(editor.selection.start, editor.selection.end);
    const selText = editor.document.getText(selRange);
    doEvaluateExpression(editor, selText, diagnostic, extContext);
}

/**
 * Asks the user to enter an expression and evalutes it in the context of the specification from the active editor.
 */
export async function evaluateExpression(diagnostic: vscode.DiagnosticCollection, extContext: vscode.ExtensionContext) {
    const editor = getEditorIfCanRunTlc(extContext);
    if (!editor) {
        return;
    }
    vscode.window.showInputBox({
        value: lastEvaluatedExpression,
        prompt: 'Enter a TLA+ expression to evaluate',
        ignoreFocusOut: true
    }).then((expr) => {
        if (!expr) {
            return;
        }
        lastEvaluatedExpression = expr;
        doEvaluateExpression(editor, expr, diagnostic, extContext);
    });
}

async function doEvaluateExpression(
    editor: vscode.TextEditor,
    expr: string,
    diagnostic: vscode.DiagnosticCollection,
    extContext: vscode.ExtensionContext
) {
    const eExpr = expr.trim();
    if (eExpr === '') {
        vscode.window.showWarningMessage('Nothing to evaluate.');
        return;
    }
    await editor.document.save();
    const tlaFilePath = editor.document.uri.fsPath;
    const cfgFilePath = replaceExtension(tlaFilePath, 'cfg');
    const cfgExists = await exists(cfgFilePath);
    const constants = cfgExists ? await extractConstants(cfgFilePath) : [];
    const num = (new Date().getTime());
    const model = await createCustomModel(
        tlaFilePath, [
            `E_${num} ==`,
            expr,
            `ASSUME PrintT(<<"${EXPR_MARKER}", E_${num}>>)`,
            `VARIABLES v_${num}`,
            `Init_${num} == FALSE /\\ v_${num} = 0`,
            `Next_${num} == FALSE /\\ v_${num}' = v_${num}`
        ], constants.concat([
            `INIT Init_${num}`,
            `NEXT Next_${num}`
        ])
    );
    if (!model) {
        return;
    }
    const specFiles = new SpecFiles(
        path.join(model.dirPath, model.tlaFileName),
        path.join(model.dirPath, model.cfgFileName)
    );
    const channel = getOutChannel();
    channel.clear();
    channel.appendLine(`Evaluating constant expression:\n${expr}\n`);
    channel.revealWindow();
    const checkResult = await doCheckModel(specFiles, true, extContext, diagnostic);
    displayResult(checkResult);
    deleteDir(model.dirPath);
}

async function extractConstants(cfgFilePath: string): Promise<string[]> {
    const lines = await readFileLines(cfgFilePath);
    const constants = [];
    let c = false;
    for (const line of lines) {
        if (/^\s*CONSTANT(S)?\b/g.test(line)) {
            c = true;
        } else if (/^\s*(SPECIFICATION|INVARIANT(S)?|PROPERT(Y|IES)|INIT|NEXT|SYMMETRY|CONSTRAINT(S)?|ACTION_CONSTRAINT(S)?|VIEW)\b/g.test(line)) {
            c = false;
        }
        if (c && line !== '') {
            constants.push(line);
        }
    }
    return constants;
}

function displayResult(checkResult: ModelCheckResult | undefined) {
    const channel = getOutChannel();
    if (!checkResult) {
        channel.appendLine('Error evaluating expression');
        return;
    }
    if (checkResult.state !== CheckState.Success) {
        checkResult.errors.forEach((err) => channel.appendLine(err.toString()));
        return;
    }
    if (checkResult.outputLines.length === 0) {
        channel.appendLine('Error: Expression value output not found.');
        return;
    }
    const val = parseVariableValue('expr', checkResult.outputLines.map((l) => l.text));
    if (!(val instanceof SequenceValue) || val.items.length !== 2) {
        channel.appendLine('Error: Unexpected expression value output\n');
        channel.appendLine(val.str);
        return;
    }
    channel.appendLine(val.items[1].str);
}

function getOutChannel(): ToolOutputChannel {
    if (!outChannel) {
        outChannel = new ToolOutputChannel('TLA+ evaluation');
    }
    return outChannel;
}
