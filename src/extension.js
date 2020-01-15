const vscode = require('vscode');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('dart_data_class.generate.from_props', () => {
        generateDataClass();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dart_data_class.generate.from_json', () => {
        generateJsonDataClass();
    }));

    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({
        language: 'dart',
        scheme: 'file'
    }, new DataClassCodeActions(), {
        providedCodeActionKinds: [
            vscode.CodeActionKind.QuickFix
        ],
    }));
}

async function generateJsonDataClass() {
    let langId = getLangId();
    if (langId == 'dart') {
        let document = getDocText();

        const name = await vscode.window.showInputBox({
            placeHolder: 'Please type in a class name.'
        });

        if (name == null || name.length == 0) {
            return;
        }

        let reader = new JsonReader(document, name);
        let seperate = true;

        if (await reader.error == null) {
            if (reader.files.length >= 2) {
                const setting = readSetting('json.seperate');
                if (setting == 'ask') {
                    const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                        canPickMany: false,
                        placeHolder: 'Do you wish to seperate the JSON into multiple files?'
                    });

                    if (r != null) {
                        seperate = r == 'Yes';
                    } else {
                        return;
                    }
                } else {
                    seperate = setting == 'seperate';
                }
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                cancellable: false
            }, async function (progress, token) {
                progress.report({ increment: 0, message: 'Generating Data Classes...' });
                scrollTo(0);
                await reader.commitJson(progress, seperate);
                clearSelection();
            });
        } else {
            showError(await reader.error);
        }
    } else if (langId == 'json') {
        showError('Please paste the JSON directly into an empty .dart file and then try again!');
    } else {
        showError('Make sure that you\'re editing a dart file and then try again!');
    }
}

async function generateDataClass(text = getDocText()) {
    if (getLangId() == 'dart') {
        const generator = new DataClassGenerator(text, null);
        let clazzes = generator.clazzes;

        // Reverse clazzes when converting from JSON and clazz length greater than 2 => 
        // dev chose single file option, to make sure classes are inserted in correct
        // order and not reversed.
        if (clazzes.length >= 2) {
            clazzes = clazzes.reverse();
        }

        // Show a prompt if there are more than one classes in the current editor.
        if (clazzes.length >= 2) {
            const result = await showClassChooser(clazzes);
            if (result != null) {
                clazzes = result;
            } else {
                showInfo('No classes selected!');
                return;
            }
        }

        console.log(clazzes);

        if (clazzes.length > 0) {
            for (let clazz of clazzes) {
                if (clazz.isValid && clazz.toReplace.length > 0) {
                    if (!readSetting('override.manual')) {
                        const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                            placeHolder: `Do you want to override changes in ${clazz.name}? Custom function implementations may not be preserved!`,
                            canPickMany: false
                        });

                        if (r == null) return;
                        else if (r != 'Yes') clazz.toReplace = [];
                    } else {
                        // When manual overriding is activated ask for every override.
                        let result = [];
                        for (let replacement of clazz.toReplace) {
                            const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                                placeHolder: `Do you want to override ${replacement.name}?`,
                                canPickMany: false
                            });

                            if (r == null) {
                                showInfo('Override flow canceled!');
                                return;
                            } else if ('Yes' == r) result.push(replacement);
                        }
                        clazz.toReplace = result;
                    }
                }
            }

			/** 
			* @param {vscode.TextEditor} editor
			*/
            await vscode.window.activeTextEditor.edit(editor => {
                for (let i = clazzes.length - 1; i >= 0; i--) {
                    const clazz = clazzes[i];

                    if (clazz.toInsert.length == 0 && clazz.toReplace.length == 0 && !clazz.constrDifferent) {
                        showInfo(`No changes detected for class ${clazz.name}`);
                    } else {
                        if (clazz.isValid) {
                            clazz.replace(editor, i);
                        } else if (clazz.issue != null) {
                            showError(clazz.issue);
                        }
                    }
                }
            });

            clearSelection();
        } else {
            showError('No convertable dart classes were detected!');
            return null;
        }

        return clazzes;
    } else {
        showError('Make sure that you\'re editing a dart file and then try again!');
        return null;
    }
}

/**
 * @param {DartClass[]} clazzez
 */
async function showClassChooser(clazzez) {
    const values = clazzez.map((v) => v.name);

    const r = await vscode.window.showQuickPick(values, {
        placeHolder: 'Please select the classes you want to generate data classes of.',
        canPickMany: true,
    });

    let result = [];
    if (r != null && r.length > 0) {
        for (let c of r) {
            for (let clazz of clazzez) {
                if (clazz.name == c)
                    result.push(clazz);
            }
        }
    } else return null;

    return result;
}

class DartClass {
    constructor() {
        /** @type {string} */
        this.name = null;
        /** @type {string} */
        this.genericType = '';
        /** @type {string} */
        this.extend = null;
        /** @type {string[]} */
        this.mixins = [];
        /** @type {string} */
        /** @type {string[]} */
        this.imports = [];
        /** @type {string} */
        this.constr = null;
        this.lastImportLine = 0;
        /** @type {ClassProperty[]} */
        this.properties = [];
        /** @type {number} */
        this.startsAtLine = null;
        /** @type {number} */
        this.endsAtLine = null;
        /** @type {number} */
        this.constrStartsAtLine = null;
        /** @type {number} */
        this.constrEndsAtLine = null;
        this.constrDifferent = true;
        this.isArray = false;
        this.classContent = '';
        this.toInsert = '';
        /** @type {ClassPart[]} */
        this.toReplace = [];
    }

    get type() {
        return this.name + this.genericType;
    }

    get propsEndAtLine() {
        if (this.properties.length > 0) {
            return this.properties[this.properties.length - 1].line;
        } else {
            return -1;
        }
    }

    get hasImports() {
        return this.imports.length > 0;
    }

    get formattedImports() {
        if (!this.hasImports) return '';

        let imps = '';
        let dartImports = [];
        let packageImports = [];
        let relativeImports = [];

        for (let imp of this.imports) {
            if (imp.includes('dart:')) {
                dartImports.push(imp);
            } else if (imp.includes('package:')) {
                packageImports.push(imp);
            } else {
                relativeImports.push(imp);
            }
        }

        let addImports = function (imports) {
            imports.sort();
            for (let i = 0; i < imports.length; i++) {
                const isLast = i == imports.length - 1;
                const imp = imports[i];
                imps += imp + '\n';

                if (isLast) {
                    imps += '\n';
                }
            }
        }

        addImports(dartImports);
        addImports(packageImports);
        addImports(relativeImports);

        return imps;
    }

    get classDetected() {
        return this.startsAtLine != null;
    }

    get hasNamedConstructor() {
        if (this.constr != null) {
            return this.constr.replace('const', '').trimLeft().startsWith(this.name + '({');
        }

        return true;
    }

    get hasConstructor() {
        return this.constrStartsAtLine != null && this.constrEndsAtLine != null && this.constr != null;
    }

    get hasMixins() {
        return this.mixins != null && this.mixins.length > 0;
    }

    get hasEnding() {
        return this.endsAtLine != null;
    }

    get areImportsSeperated() {
        return this.lastImportLine == 0 || this.lastImportLine != this.startsAtLine - 1;
    }

    get hasProperties() {
        return this.properties.length > 0;
    }

    get fewProps() {
        return this.properties.length <= 3;
    }

    get isValid() {
        return this.classDetected && this.hasEnding && this.hasProperties && this.uniquePropNames && this.areImportsSeperated;
    }

    get isWidget() {
        return this.extend != null && (this.extend == 'StatelessWidget' || this.extend == 'StatefulWidget');
    }

    get isStatelessWidget() {
        return this.isWidget && this.extend != null && this.extend == 'StatelessWidget';
    }

    get isState() {
        return !this.isWidget && this.extend != null && this.extend.startsWith('State<');
    }

    get isAbstract() {
        return this.classContent.trimLeft().startsWith('abstract class');
    }

    get issue() {
        const def = this.name + ' couldn\'t be converted to a data class: '
        let msg = def;
        if (!this.hasProperties) msg += 'Class must have at least one property!';
        else if (!this.hasEnding) msg += 'Class has no ending!';
        else if (!this.uniquePropNames) msg += 'Class doesn\'t have unique property names!';
        else if (!this.areImportsSeperated) msg += 'Class must be seperated by at least one line from import statements!';
        else msg = removeEnd(msg, ': ') + '.';
        if (msg != def) {
            return msg;
        } else {
            return null;
        }
    }

    get uniquePropNames() {
        let props = [];
        for (let p of this.properties) {
            const n = p.name;
            if (props.includes(n))
                return false;
            props.push(n);
        }
        return true;
    }

    /**
     * @param {number} line
     */
    replacementAtLine(line) {
        for (let part of this.toReplace) {
            if (part.startsAt <= line && part.endsAt >= line) {
                return part.replacement;
            }
        }

        return null;
    }

    getClassReplacement(withImports = true) {
        let replacement = '';
        let lines = this.classContent.split('\n');

        for (let i = this.endsAtLine - this.startsAtLine; i >= 0; i--) {
            let line = lines[i] + '\n';
            let l = this.startsAtLine + i;

            if (i == 0) {
                let classLine = 'class ' + this.name + this.genericType;
                if (this.extend != null) {
                    classLine += ' extends ' + this.extend;
                }

                if (this.hasMixins) {
                    let length = this.mixins.length;
                    classLine += ' with '
                    for (let m = 0; m < length; m++) {
                        let isLast = m == length - 1;
                        let mixin = this.mixins[m];
                        classLine += mixin;

                        if (!isLast) {
                            classLine += ', ';
                        }
                    }
                }

                classLine += ' {\n';
                replacement = classLine + replacement;
            } else if (l == this.propsEndAtLine && this.constr != null && !this.hasConstructor) {
                replacement = this.constr + replacement;
                replacement = line + replacement;
            } else if (l == this.endsAtLine && this.isValid) {
                replacement = line + replacement;
                replacement = this.toInsert + replacement;
            } else {
                let rp = this.replacementAtLine(l);
                if (rp != null) {
                    if (!replacement.includes(rp))
                        replacement = rp + '\n' + replacement;
                } else {
                    replacement = line + replacement;
                }
            }
        }

        if (withImports && this.hasImports) {
            replacement = this.formattedImports + replacement;
        }

        return removeEnd(replacement, '\n');
    }

	/**
     * @param {vscode.TextEditorEdit} editor
	 * @param {number} [index]
	 */
    replace(editor, index) {
        editorReplace(
            editor,
            this.startsAtLine - 1,
            this.endsAtLine,
            this.getClassReplacement(false)
        );

        // If imports need to be inserted, do it at the top of the file.
        if (this.hasImports && index == 0) {
            if (this.lastImportLine == 0) {
                editorInsert(editor, 0, this.formattedImports);
            } else {
                editorReplace(
                    editor, 0, this.lastImportLine, removeEnd(this.formattedImports, '\n')
                );
            }
        }
    }
}

class ClassProperty {
	/**
	 * @param {String} type
	 * @param {String} name
	 * @param {number} line
	 * @param {boolean} isFinal
	 */
    constructor(type, name, line = 1, isFinal = true) {
        this.type = type;
        this.jsonName = name;
        this.name = toVarName(name);
        this.line = line;
        this.isFinal = isFinal;
    }

    get isList() {
        return this.type.startsWith('List<');
    }

    get listType() {
        if (this.isList) {
            const type = this.type.replace('List<', '').replace('>', '');
            return new ClassProperty(type, this.name, this.line, this.isFinal);
        }

        return this;
    }

    get isPrimitive() {
        let t = this.listType.type;
        return t == 'String' || t == 'num' || t == 'dynamic' || t == 'bool' || this.isDouble || this.isInt;
    }

    get defValue() {
        if (this.isList) {
            return 'const []';
        } else {
            switch (this.type) {
                case 'String': return "''";
                case 'num':
                case 'int': return "0";
                case 'double': return "0.0";
                case 'bool': return 'false';
                case 'dynamic': return "null";
                default: return `${this.type}()`;
            }
        }
    }

    get isInt() {
        return this.listType.type == 'int';
    }

    get isDouble() {
        return this.listType.type == 'double';
    }
}

class ClassPart {

    /**
     * @param {string} name
     * @param {number} startsAt
     * @param {number} endsAt
     * @param {string} current
     * @param {string} replacement
     */
    constructor(name, startsAt = null, endsAt = null, current = null, replacement = null) {
        this.name = name;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.current = current;
        this.replacement = replacement;
    }

    get isValid() {
        return this.startsAt != null && this.endsAt != null && this.current != null;
    }

    get startPos() {
        return new vscode.Position(this.startsAt, 0);
    }

    get endPos() {
        return new vscode.Position(this.endsAt, 0);
    }
}

class DataClassGenerator {
    /**
     * @param {String} text
     * @param {DartClass[]} clazzes
     * @param {boolean} fromJSON
     * @param {string} part
     */
    constructor(text, clazzes = null, fromJSON = false, part = null) {
        this.text = text;
        this.fromJSON = fromJSON;
        this.clazzes = clazzes == null ? this.getClasses() : clazzes;
        this.part = part;
        this.generateDataClazzes();
        this.clazz = null;
    }

	/**
	 * @param {string[]} imps
	 */
    hastAtLeastOneImport(imps) {
        for (let imp of imps) {
            const impt = `import '${imp}';`;
            if (this.text.includes(impt) || this.clazz.imports.includes(impt))
                return true;
        }
        return false;
    }

    /**
     * @param {string} part
     */
    isPart(part) {
        return this.part == null ? true : this.part == part;
    }

    generateDataClazzes() {
        const insertConstructor = readSetting('constructor.enabled') && this.isPart('constructor');

        for (let clazz of this.clazzes) {
            this.clazz = clazz;

            if (insertConstructor)
                this.insertConstructor(clazz);

            if (!clazz.isWidget && !clazz.isAbstract) {
                if (readSetting('copyWith.enabled') && this.isPart('copyWith'))
                    this.insertCopyWith(clazz);
                if (readSetting('toMap.enabled') && this.isPart('serialization'))
                    this.insertToMap(clazz);
                if (readSetting('fromMap.enabled') && this.isPart('serialization'))
                    this.insertFromMap(clazz);
                if (readSetting('toJson.enabled') && this.isPart('serialization'))
                    this.insertToJson(clazz);
                if (readSetting('fromJson.enabled') && this.isPart('serialization'))
                    this.insertFromJson(clazz);
                if (readSetting('toString.enabled') && this.isPart('toString'))
                    this.insertToString(clazz);

                if (readSetting('useEquatable') && this.isPart('useEquatable')) {
                    this.insertEquatable(clazz);
                } else {
                    if (readSetting('equality.enabled') && this.isPart('equality'))
                        this.insertEquality(clazz);
                    if (readSetting('hashCode.enabled') && this.isPart('hashCode'))
                        this.insertHash(clazz);
                }
            }
        }
    }

    /**
     * @param {string} name
     * @param {string} finder
     * @param {DartClass} clazz
     */
    findPart(name, finder, clazz) {
        const lines = clazz.classContent.split('\n');
        const part = new ClassPart(name);
        let curlies = 0;
        let singleLine = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = clazz.startsAtLine + i;

            curlies += count(line, '{');
            curlies -= count(line, '}');

            if (part.startsAt == null && line.trimLeft().startsWith(finder.trimLeft())) {
                if (line.includes('=>')) singleLine = true;
                if (curlies == 2 || singleLine) {
                    part.startsAt = lineNum;
                    part.current = line + '\n';
                }
            } else if (part.startsAt != null && part.endsAt == null && (curlies == 2 || singleLine)) {
                part.current += line + '\n';
            } else if (part.startsAt != null && part.endsAt == null && curlies == 1) {
                part.endsAt = lineNum;
                part.current += line;
            }

            // Detect the end of a single line function by searching for the ';' because
            // a single line function doesn't necessarily only have one single line.
            if (singleLine && part.startsAt != null && part.endsAt == null && line.trimRight().endsWith(';')) {
                part.endsAt = lineNum;
            }
        }

        return part.isValid ? part : null;
    }

    /**
     * If class already exists and has a constructor with the parameter, reuse that parameter.
     * E.g. when the dev changed the parameter from this.x to this.x = y the generator inserts
     * this.x = y. This way the generator can preserve changes made in the constructor.
     * 
     * @param {string} p
	 * @param {DartClass} clazz
     */
    findConstrParameter(p, clazz) {
        // Always return null for non-existent or single line constructors.
        if (clazz.hasConstructor && clazz.constrStartsAtLine != clazz.constrEndsAtLine) {
            const lines = clazz.constr.split('\n');
            for (let line of lines) {
                for (let w of line.trim().split(' ')) {
                    // Search for this.[x]. If found, return trimmed line.
                    if (removeEnd(w, ',') == p) return line.trim();
                }
            }
        }

        return null;
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertConstructor(clazz) {
        const defVal = readSetting('constructor.default_values');
        const required = readSetting('constructor.required');
        let constr = '';
        let startBracket = '({';
        let endBracket = '})';

        if (required) {
            this.requiresImport('package:flutter/foundation.dart', [
                'package:flutter/material.dart',
                'package:flutter/cupertino.dart',
                'package:flutter/widgets.dart'
            ]);
        }

        if (clazz.constr != null) {
            if (clazz.constr.trimLeft().startsWith('const'))
                constr += 'const ';

            // Detect custom constructor brackets and preserve them.
            const fConstr = clazz.constr.replace('const', '').trimLeft();
            if (fConstr.startsWith(clazz.name + '([')) startBracket = '([';
            else if (fConstr.startsWith(clazz.name + '({')) startBracket = '({';
            else startBracket = '(';
            if (fConstr.includes('])')) endBracket = '])';
            else if (fConstr.includes('})')) endBracket = '})';
            else endBracket = ')';
        }

        constr += clazz.name + startBracket + '\n';
        if (clazz.isWidget) constr += '  Key key,\n'

        for (let p of clazz.properties) {
            let parameter = `this.${p.name}`
            const fp = this.findConstrParameter(parameter, clazz);
            const addDefault = endBracket != ')' && defVal && !required && ((p.isPrimitive || p.isList) && p.type != 'dynamic');

            constr += '  ';
            if (required) parameter = '@required ' + parameter;
            if (fp == null) {
                constr += `${parameter}${addDefault ? ` = ${p.defValue}` : ''}` + ',';
            } else {
                constr += fp;
            }
            constr += '\n';
        }

        const stdConstrEnd = () => {
            constr += endBracket + (clazz.isWidget ? ' : super(key: key);' : ';');
        }

        if (clazz.constr != null) {
            let i = null;
            if (clazz.constr.includes(':')) i = clazz.constr.indexOf(':');
            else if (clazz.constr.trimRight().endsWith('{')) i = clazz.constr.lastIndexOf('{');

            if (i != null) {
                let ending = clazz.constr.substring(i, clazz.constr.length);
                constr += `${endBracket} ${ending}`;
            } else {
                stdConstrEnd();
            }
        } else {
            stdConstrEnd();
        }

        if (clazz.hasConstructor) {
            clazz.constrDifferent = !areStrictEqual(clazz.constr, constr);
            if (clazz.constrDifferent) {
                constr = removeEnd(indent(constr), '\n');
                this.replace(new ClassPart('constructor', clazz.constrStartsAtLine, clazz.constrEndsAtLine, clazz.constr, constr), clazz);
            }
        } else {
            this.append(constr, clazz, true);
        }
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertCopyWith(clazz) {
        let method = clazz.type + ' copyWith({\n';
        for (let p of clazz.properties) {
            method += '  ' + p.type + ' ' + p.name + ',\n';
        }
        method += '}) {\n';
        method += '  return ' + clazz.type + '(\n';

        for (let p of clazz.properties) {
            method += `    ${clazz.hasNamedConstructor ? `${p.name}: ` : ''}${p.name} ?? this.${p.name},\n`;
        }

        method += '  );\n'
        method += '}';

        this.appendOrReplace('copyWith', method, `${clazz.type} copyWith(`, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToMap(clazz) {
        let props = clazz.properties;
        let customTypeMapping = function (prop, name = null, endFlag = ',\n') {
            prop = prop.isList ? prop.listType : prop;
            name = name == null ? prop.name : name;
            switch (prop.type) {
                case 'DateTime':
                    return `${name}.millisecondsSinceEpoch${endFlag}`;
                case 'Color':
                    return `${name}.value${endFlag}`;
                case 'IconData':
                    return `${name}.codePoint${endFlag}`
                default:
                    return `${name}${!prop.isPrimitive ? '.toMap()' : ''}${endFlag}`;
            }

        }

        let method = `Map<String, dynamic> toMap() {\n`;
        method += '  return {\n';
        for (let p of props) {
            method += `    '${p.jsonName}': `;
            if (!p.isList) {
                method += customTypeMapping(p);
            } else {
                method += `List<dynamic>.from(${p.name}.map((x) => `;
                const endFlag = ')),\n';
                if (p.isPrimitive) {
                    method += 'x' + endFlag;
                } else {
                    method += customTypeMapping(p, 'x', endFlag);
                }
            }
            if (p.name == props[props.length - 1].name) method += '  };\n';
        }
        method += '}';

        this.appendOrReplace('toMap', method, 'Map<String, dynamic> toMap()', clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertFromMap(clazz) {
        let defVal = readSetting('fromMap.default_values');
        let props = clazz.properties;
        const fromJSON = this.fromJSON;

        let customTypeMapping = function (prop, value = null) {
            prop = prop.isList ? prop.listType : prop;
            const addDefault = defVal && prop.type != 'dynamic';
            const endFlag = value == null ? ',\n' : '';
            value = value == null ? "map['" + prop.jsonName + "']" : value;

            switch (prop.type) {
                case 'DateTime':
                    return `DateTime.fromMillisecondsSinceEpoch(${value})${endFlag}`;
                case 'Color':
                    return `Color(${value})${endFlag}`;
                case 'IconData':
                    return `IconData(${value}, fontFamily: 'MaterialIcons')${endFlag}`
                default:
                    return `${!prop.isPrimitive ? prop.type + '.fromMap(' : ''}${value}${!prop.isPrimitive ? ')' : ''}${fromJSON ? (prop.isDouble ? '?.toDouble()' : prop.isInt ? '?.toInt()' : '') : ''}${addDefault ? ` ?? ${prop.defValue}` : ''}${endFlag}`;
            }
        }

        let method = 'static ' + clazz.name + ' fromMap(Map<String, dynamic> map) {\n';
        method += '  if (map == null) return null;\n\n';
        method += '  return ' + clazz.name + '(\n';
        for (let p of props) {
            method += `    ${clazz.hasNamedConstructor ? `${p.name}: ` : ''}`;
            if (!p.isList) {
                method += customTypeMapping(p);
            } else {
                method += `${p.type}.from(`;
                if (p.isPrimitive) {
                    method += `map['${p.jsonName}']${defVal ? ' ?? []' : ''}),\n`;
                } else {
                    method += `map['${p.jsonName}']?.map((x) => ${customTypeMapping(p, 'x')})`;
                    method += `${defVal ? ' ?? []' : ''}),\n`;
                }
            }
            if (p.name == props[props.length - 1].name) method += '  );\n';
        }
        method += '}';

        this.appendOrReplace('fromMap', method, `static ${clazz.name} fromMap(Map<String, dynamic> map)`, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToJson(clazz) {
        this.requiresImport('dart:convert');

        const method = 'String toJson() => json.encode(toMap());';
        this.appendOrReplace('toJson', method, 'String toJson()', clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertFromJson(clazz) {
        this.requiresImport('dart:convert');

        const method = `static ${clazz.name} fromJson(String source) => fromMap(json.decode(source));`;
        this.appendOrReplace('fromJson', method, `static ${clazz.name} fromJson(String source)`, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToString(clazz) {
        const short = clazz.fewProps;
        const props = clazz.properties;
        let method = '@override\n';
        method += `String toString() ${!short ? '{\n' : '=>'}`;
        method += `${!short ? '  return' : ''} '` + clazz.name;
        for (let p of props) {
            method += ' ' + p.name + ': $' + p.name + ',';
            if (p.name == props[props.length - 1].name) {
                method = removeEnd(method, ',');
                method += "';" + (short ? '' : '\n');
            }
        }
        method += !short ? '}' : '';

        this.appendOrReplace('toString', method, 'String toString()', clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertEquality(clazz) {
        const props = clazz.properties;
        let method = '@override\n';
        method += 'bool operator ==(Object o) {\n';
        method += '  if (identical(this, o)) return true;\n\n';
        method += '  return o is ' + clazz.type + ' &&\n';
        for (let p of props) {
            method += '    o.' + p.name + ' == ' + p.name;
            if (p.name != props[props.length - 1].name) method += ' &&\n';
            else method += ';\n';
        }
        method += '}';

        this.appendOrReplace('equality', method, 'bool operator ==', clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertHash(clazz) {
        const useJenkins = readSetting('hashCode.use_jenkins');
        const short = !useJenkins && clazz.fewProps;
        const props = clazz.properties;
        let method = '@override\n';
        method += `int get hashCode ${short ? '=>' : '{\n  return '}`;

        if (useJenkins) {
            // dart:ui import is required for Jenkins hash.
            this.requiresImport('dart:ui', [
                'package:flutter/material.dart',
                'package:flutter/cupertino.dart',
                'package:flutter/widgets.dart'
            ]);

            method += `hashList([\n`;
            for (let p of props) {
                method += '    ' + p.name + `,\n`;
            }
            method += '  ]);';
        } else {
            for (let p of props) {
                const isFirst = p == props[0];
                method += `${isFirst && !short ? '' : short ? ' ' : '    '}${p.name}.hashCode`;
                if (p == props[props.length - 1]) {
                    method += ';';
                } else {
                    method += ` ^${!short ? '\n' : ''}`;
                }
            }
        }

        if (!short) method += '\n}';

        this.appendOrReplace('hashCode', method, 'int get hashCode', clazz);
    }

    /**
	 * @param {DartClass} clazz
	 */
    insertEquatable(clazz) {
        this.requiresImport('package:equatable/equatable.dart');
        this.addMixin('EquatableMixin');

        const props = clazz.properties;
        const short = props.length <= 4;
        const split = ', ';
        const startFlag = '[';
        const endFlag = ']';
        let method = '@override\n';
        method += `List<Object> get props ${!short ? '{\n' : '=>'}`;
        method += `${!short ? '  return' : ''} ` + startFlag;
        for (let p of props) {
            method += p.name + split;
            if (p.name == props[props.length - 1].name) {
                method = removeEnd(method, split);
                method += endFlag + ";" + (short ? '' : '\n');
            }
        }
        method += !short ? '}' : '';

        this.appendOrReplace('props', method, 'List<Object> get props', clazz);
    }

    /**
     * @param {string} imp
     * @param {string[]} validOverrides
     */
    requiresImport(imp, validOverrides = []) {
        const imports = this.clazz.imports;
        const formattedImport = "import '" + imp + "';";

        if (!imports.includes(formattedImport) && !this.hastAtLeastOneImport(validOverrides)) {
            imports.push(formattedImport);
        }
    }

    /**
     * @param {string} mixin
     */
    addMixin(mixin) {
        const mixins = this.clazz.mixins;
        if (!mixins.includes(mixin)) {
            mixins.push(mixin);
        }
    }

    /**
     * @param {string} clazz
     */
    setSuperClass(clazz) {
        this.clazz.extend = clazz;
    }

    /**
     * @param {string} name
     * @param {string} n
     * @param {string} finder
     * @param {DartClass} clazz
     */
    appendOrReplace(name, n, finder, clazz) {
        let part = this.findPart(name, finder, clazz);
        let replacement = removeEnd(indent(n.replace('@override\n', '')), '\n');
        if (part != null) {
            part.replacement = replacement;
            if (!areStrictEqual(part.current, part.replacement)) {
                this.replace(part, clazz);
            }
        } else {
            this.append(n, clazz);
        }
    }

	/**
	 * @param {string} method
	 * @param {DartClass} clazz
	 */
    append(method, clazz, constr = false) {
        let met = indent(method);
        constr ? clazz.constr = met : clazz.toInsert += '\n' + met;
    }

    /**
     * @param {ClassPart} part
     * @param {DartClass} clazz
     */
    replace(part, clazz) {
        clazz.toReplace.push(part);
    }

    getClasses() {
        let clazzes = [];
        let imports = [];
        let lastImportLine = 0;
        let clazz = new DartClass();

        let lines = this.text.split('\n');
        let curlyBrackets = 0;
        let brackets = 0;

        for (let x = 0; x < lines.length; x++) {
            const line = lines[x];
            const linePos = x + 1;
            // Make sure to look for 'class ' with the space in order to allow
            // fields that contain the word 'class' as in classifire.
            // issue: https://github.com/BendixMa/Dart-Data-Class-Generator/issues/2
            const classLine = line.includes('class ');
            const importLine = !clazz.classDetected && line.startsWith('import');

            if (importLine) {
                imports.push(line.trim());
                lastImportLine = linePos;
            } else if (classLine) {
                clazz = new DartClass();
                clazz.startsAtLine = linePos;
                clazz.imports = imports;
                clazz.lastImportLine = lastImportLine;

                let classNext = false;
                let extendsNext = false;
                let mixinsNext = false;

                for (let word of line.split(' ')) {
                    if (word.length > 0 && word != '{') {
                        if (word.endsWith('{')) {
                            word = word.substring(0, word.length - 1);
                        }


                        if (word == 'class') {
                            classNext = true;
                        } else if (classNext) {
                            classNext = false;
                            let name = word;

                            // Remove generics from class name.
                            if (name.includes('<')) {
                                clazz.genericType = name.substring(
                                    name.indexOf('<'),
                                    name.lastIndexOf('>') + 1,
                                );

                                name = name.substring(0, name.indexOf('<'));
                            }


                            clazz.name = name;
                        } else if (word == 'extends') {
                            extendsNext = true;
                        } else if (extendsNext) {
                            extendsNext = false;
                            clazz.extend = word;
                        } else if (word == 'with') {
                            mixinsNext = true;
                        } else if (mixinsNext) {
                            let mixin = removeEnd(word, ',').trim();

                            if (mixin.length > 0) {
                                clazz.mixins.push(mixin);
                            }
                        }
                    }
                }

                // Do not add State<T> classes of widgets.
                if (!clazz.isState) {
                    clazzes.push(clazz);
                }
            }

            if (clazz.classDetected) {
                // Check if class ended based on bracket count. If all '{' have a '}' pair,
                // class can be closed.
                curlyBrackets += count(line, '{');
                curlyBrackets -= count(line, '}');
                // Count brackets, e.g. to find the of the constructor.
                brackets += count(line, '(');
                brackets -= count(line, ')');

                if (clazz.constrStartsAtLine == null && curlyBrackets == 1) {
                    // Check if a line is valid to only include real properties.
                    const lineValid = !line.trimLeft().startsWith(clazz.name) &&
                        !includesOne(line, ['static', ' set ', ' get ', '{', '}', '=>', 'return', '@']) &&
                        // Do not include final values that are assigned a value.
                        !includesAll(line, ['final', '=']);
                    if (lineValid) {
                        let type = null;
                        let name = null;
                        let isFinal = false;

                        const words = line.trim().split(' ');
                        for (let i = 0; i < words.length; i++) {
                            const word = words[i];
                            const isLast = i == words.length - 1;

                            if (word.length > 0 && word != '}' && word != '{') {
                                if (word == 'final') isFinal = true;

                                // Be sure to not include keywords.
                                if (word != 'final' && word != 'const') {
                                    // If word ends with semicolon => variable name, else type.
                                    const isVariable = word.endsWith(';') || (!isLast && (words[i + 1] == '='));
                                    if (isVariable) {
                                        if (name == null)
                                            name = removeEnd(word, ';');
                                    } else {
                                        if (type == null) type = word;
                                        // Types can have gaps => Pair<A, B>,
                                        // thus append word to type if a name hasn't
                                        // been detected.
                                        else if (name == null) type += ' ' + word;
                                    }
                                }
                            }
                        }

                        if (type != null && name != null) {
                            clazz.properties.push(new ClassProperty(type, name, linePos, isFinal));
                        }
                    }
                }

                // Detect beginning of constructor by looking for the class name and a bracket, while also
                // making sure not to falsely detect a function constructor invocation with the actual 
                // constructor with boilerplaty checking all possible constructor options.
                let name = clazz.name;
                let includesConstr = line.replace('const', '').trimLeft().startsWith(name + '(');
                if (includesConstr && !classLine) {
                    clazz.constrStartsAtLine = linePos;
                }

                if (clazz.constrStartsAtLine != null && clazz.constrEndsAtLine == null) {
                    clazz.constr = clazz.constr == null ? line + '\n' : clazz.constr + line + '\n';
                    // Detect end of constructor.
                    if (brackets == 0) {
                        clazz.constrEndsAtLine = linePos;
                        clazz.constr = removeEnd(clazz.constr, '\n');
                    }
                }

                clazz.classContent += line;
                // Detect end of class.
                if (curlyBrackets != 0) {
                    clazz.classContent += '\n';
                } else {
                    clazz.endsAtLine = linePos;
                    clazz = new DartClass();
                }
            }
        }

        return clazzes;
    }
}

class DartFile {
	/**
	 * @param {DartClass} clazz
	 * @param {string} content
	 */
    constructor(clazz, content = null) {
        this.clazz = clazz;
        this.name = createFileName(clazz.name);
        this.content = content || clazz.classContent;
    }
}

class JsonReader {
	/**
	 * @param {string} source
	 * @param {string} className
	 */
    constructor(source, className) {
        this.json = this.toPlainJson(source);

        this.clazzName = capitalize(className);
        /** @type {DartClass[]} */
        this.clazzes = [];
        /** @type {DartFile[]} */
        this.files = [];

        this.error = this.checkJson();
    }

    async checkJson() {
        const isArray = this.json.startsWith('[');
        if (isArray && !this.json.includes('{')) {
            return 'Primitive JSON arrays are not supported! Please serialize them directly.';
        }

        if (await this.generateFiles()) {
            return 'The provided JSON is malformed or couldn\'t be parsed!';
        }

        return null;
    }

	/**
	 * @param {string} source
	 */
    toPlainJson(source) {
        return source.replace(new RegExp(' ', 'g'), '').replace(new RegExp('\n', 'g'), '');
    }

	/**
	 * @param {any} value
	 */
    getPrimitive(value) {
        let type = typeof (value);
        let sType = null;

        if (type === 'number') {
            sType = Number.isInteger(value) ? 'int' : 'double';
        } else if (type === 'string') {
            sType = 'String'
        } else if (type === 'boolean') {
            sType = 'bool';
        }

        return sType;
    }

	/**
	 * Create DartClasses from a JSON mapping with class content and properties.
	 * This is intended only for creating new files not overriding exisiting ones.
	 * 
	 * @param {any} object
	 * @param {string} key
	 */
    getClazzes(object, key) {
        let clazz = new DartClass();
        clazz.startsAtLine = 1;
        clazz.name = capitalize(key);

        let isArray = false;
        if (object instanceof Array) {
            isArray = true;
            clazz.isArray = true;
            clazz.name += 's';
        } else {
            // Top level arrays are currently not supported!
            this.clazzes.push(clazz);
        }

        let i = 1;
        clazz.classContent += 'class ' + clazz.name + ' {\n';
        for (let key in object) {
            // named key for class names.
            let k = !isArray ? key : removeEnd(clazz.name.toLowerCase(), 's');

            let value = object[key];
            let type = this.getPrimitive(value);

            if (type == null) {
                if (value instanceof Array) {
                    if (value.length > 0) {
                        let listType = k;
                        // Adjust the class name of lists. E.g. a key with items
                        // becomes a class name of Item.
                        if (k.endsWith('ies')) listType = removeEnd(k, 'ies') + 'y';
                        if (k.endsWith('s')) listType = removeEnd(k, 's');
                        const i0 = this.getPrimitive(value[0]);

                        if (i0 == null) {
                            this.getClazzes(value[0], listType);
                            type = 'List<' + capitalize(listType) + '>';
                        } else {
                            type = 'List<' + i0 + '>';
                        }
                    } else {
                        type = 'List<dynamic>';
                    }
                } else {
                    this.getClazzes(value, k);
                    type = !isArray ? capitalize(key) : `List<${capitalize(k)}>`;
                }
            }

            clazz.properties.push(new ClassProperty(type, k, ++i));
            clazz.classContent += `  final ${type} ${toVarName(k)};\n`;

            // If object is JSONArray, break after first item.
            if (isArray) break;
        }
        clazz.endsAtLine = ++i;
        clazz.classContent += '}';
    }

	/**
	 * @param {string} property
	 */
    getGeneratedTypeCount(property) {
        let p = new ClassProperty(property, 'x');
        let i = 0;
        if (!p.isPrimitive) {
            for (let clazz of this.clazzes) {
                if (clazz.name == p.type) {
                    i++;
                }
            }
        }

        return i;
    }

    async generateFiles() {
        try {
            const json = JSON.parse(this.json);
            this.getClazzes(json, this.clazzName);
            this.removeDuplicates();

            for (let clazz of this.clazzes) {
                this.files.push(new DartFile(clazz));
            }

            return false;
        } catch (e) {
            console.log(e.msg);
            return true;
        }
    }

    // If multiple clazzes of the same class exist, remove the duplicates
    // before writing them.
    removeDuplicates() {
        let result = [];
        let clazzes = this.clazzes.map((item) => item.classContent);
        clazzes.forEach((item, index) => {
            if (clazzes.indexOf(item) == index) {
                result.push(this.clazzes[index]);
            }
        });

        this.clazzes = result;
    }

	/**
	 * @param {DartClass} clazz
	 */
    addGeneratedFilesAsImport(clazz) {
        for (let prop of clazz.properties) {
            // Import only inambigous generated types.
            // E.g. if there are multiple generated classes with
            // the same name, do not include an import of that class.
            if (this.getGeneratedTypeCount(prop.listType.type) == 1) {
                let imp = `import '${createFileName(prop.listType.type)}.dart';`;
                clazz.imports.push(imp);
            }
        }
    }

	/**
	 * @param {vscode.Progress} progress
	 * @param {boolean} seperate
	 */
    async commitJson(progress, seperate) {
        let path = getCurrentPath();
        let f = '';

        const length = this.files.length;
        for (let i = 0; i < length; i++) {
            const file = this.files[i];
            const isLast = i == length - 1;
            const generator = new DataClassGenerator(file.content, [file.clazz], true);

            progress.report({
                increment: ((1 / length) * 100),
                message: `Creating file ${file.name}...`
            });

            if (seperate) {
                const clazz = generator.clazzes[0];
                this.addGeneratedFilesAsImport(clazz)

                if (i > 0) {
                    await writeFile(clazz.getClassReplacement(), file.name, false, path);
                } else {
                    await getEditor().edit(editor => {
                        editorReplace(editor, 0, null, clazz.getClassReplacement());
                    });
                }

                // Slow the writing process intentionally down.
                await new Promise(resolve => setTimeout(() => resolve(), 120));
            } else {
                // Insert in current file when JSON should not be seperated.
                for (let clazz of generator.clazzes) {
                    f += clazz.getClassReplacement(false) + '\n\n';
                }

                if (isLast) {
                    f = removeEnd(f, '\n\n');
                    await getEditor().edit(editor => {
                        editorReplace(editor, 0, null, f);
                        editorInsert(editor, 0, file.clazz.formattedImports);
                    });
                }
            }
        }
    }
}

class DataClassCodeActions {
    constructor() {
        this.clazz = new DartClass();
        this.generator = null;
        this.document = getDoc();
        this.line = '';
        this.lineNumber = 0;
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     */
    provideCodeActions(document, range) {
        if (!readSetting('quick_fixes')) {
            return;
        }

        const codeActions = [];
        this.document = document;
        this.lineNumber = range.start.line + 1;
        this.line = document.lineAt(range.start).text;
        this.generator = new DataClassGenerator(document.getText());
        this.clazz = this.getClass();

        if (this.clazz == null || !this.clazz.isValid) {
            return;
        }

        const requiredFix = this.createMakeRequiredFix();
        if (requiredFix != null) codeActions.push(requiredFix);

        const validLine = this.lineNumber == this.clazz.startsAtLine || this.lineNumber == this.clazz.constrStartsAtLine;
        if (!validLine) return codeActions;

        if (readSetting('constructor.enabled'))
            codeActions.push(this.createConstructorFix());

        if (!this.clazz.isWidget && !this.clazz.isAbstract) {
            codeActions.splice(0, 0, this.createDataClassFix(this.clazz));

            if (readSetting('copyWith.enabled'))
                codeActions.push(this.createCopyWithFix());
            if (readSettings(['toMap.enabled', 'fromMap.enabled', 'toJson.enabled', 'fromJson.enabled']))
                codeActions.push(this.createSerializationFix());
            if (readSetting('toString.enabled'))
                codeActions.push(this.createToStringFix());

            if (readSetting('useEquatable'))
                codeActions.push(this.createUseEquatableFix());
            else if (readSettings(['equality.enabled', 'hashCode.enabled']))
                codeActions.push(this.createEqualityFix());

        }

        return codeActions;
    }

    /**
     * @param {string} description
     * @param {(arg0: vscode.WorkspaceEdit) => void} editor
     */
    createFix(description, editor) {
        const fix = new vscode.CodeAction(description, vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        editor(edit);
        fix.edit = edit;
        return fix;
    }

    /**
     * @param {DartClass} clazz
     */
    createDataClassFix(clazz) {
        const fix = new vscode.CodeAction('Generate data class', vscode.CodeActionKind.QuickFix);
        fix.edit = this.getReplaceEdit(clazz);
        return fix;
    }

    /**
     * @param {string} part
     * @param {string} description
     */
    constructQuickFix(part, description) {
        const generator = new DataClassGenerator(this.document.getText(), null, false, part);
        const fix = new vscode.CodeAction(description, vscode.CodeActionKind.QuickFix);
        fix.edit = this.getReplaceEdit(this.findQuickFixClazz(generator));
        return fix;
    }

    createConstructorFix() {
        return this.constructQuickFix('constructor', 'Generate constructor');
    }

    createCopyWithFix() {
        return this.constructQuickFix('copyWith', 'Generate copyWith');
    }

    createSerializationFix() {
        return this.constructQuickFix('serialization', 'Generate JSON serialization');
    }

    createToStringFix() {
        return this.constructQuickFix('toString', 'Generate toString');
    }

    createEqualityFix() {
        return this.constructQuickFix('equality', 'Generate equality');
    }

    createUseEquatableFix() {
        return this.constructQuickFix('useEquatable', 'Generate equatable');
    }

    createMakeRequiredFix() {
        /**
         * @param {string} match
         */
        const includes = (match) => this.line.includes(match);

        if (!includes('@required') && includes('this.') && !includes('=') && this.clazz.constr.includes('})')) {
            if (this.lineNumber > this.clazz.constrStartsAtLine && this.lineNumber < this.clazz.constrEndsAtLine) {
                const inset = getLineInset(this.line);
                return this.createFix('Annotate with @required', (edit) => {
                    edit.insert(this.document.uri, new vscode.Position(this.lineNumber - 1, inset), '@required ');
                });
            }
        }

        return null;
    }

    /**
     * @param {DataClassGenerator} generator
     */
    findQuickFixClazz(generator) {
        for (let clazz of generator.clazzes) {
            if (clazz.name == this.clazz.name)
                return clazz;
        }
    }

    /**
     * @param {DartClass} clazz
     */
    getReplaceEdit(clazz) {
        const edit = new vscode.WorkspaceEdit();
        const uri = this.document.uri;

        edit.replace(uri, new vscode.Range(
            new vscode.Position((clazz.startsAtLine - 1), 0),
            new vscode.Position(clazz.endsAtLine, 1)
        ), clazz.getClassReplacement(false));

        // If imports need to be inserted, do it at the top of the file.
        if (clazz.hasImports) {
            if (clazz.lastImportLine == 0) {
                edit.insert(
                    uri,
                    new vscode.Position(0, 0),
                    clazz.formattedImports
                );
            } else {
                edit.replace(uri, new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(clazz.lastImportLine, 1)
                ), removeEnd(clazz.formattedImports, '\n'));
            }
        }

        return edit;
    }

    getClass() {
        for (let clazz of this.generator.clazzes) {
            if (clazz.startsAtLine <= this.lineNumber && clazz.endsAtLine >= this.lineNumber) {
                return clazz;
            }
        }
    }
}

/**
 * @param {string} name
 */
function createFileName(name) {
    let r = '';
    for (let i = 0; i < name.length; i++) {
        let c = name[i];
        if (c == c.toUpperCase()) {
            if (i == 0) r += c.toLowerCase();
            else r += '_' + c.toLowerCase();
        } else {
            r += c;
        }
    }

    return r;
}

function getCurrentPath() {
    let path = vscode.window.activeTextEditor.document.fileName;
    let dirs = path.split("\\");
    path = '';
    for (let i = 0; i < dirs.length; i++) {
        let dir = dirs[i];
        if (i < dirs.length - 1) {
            path += dir + "\\";
        }
    }

    return path;
}

/**
 * @param {string} content
 * @param {string} name
 */
async function writeFile(content, name, open = true, path = getCurrentPath()) {
    let p = path + name + '.dart';
    if (fs.existsSync(p)) {
        let i = 0;
        do {
            p = path + name + '_' + ++i + '.dart'
        } while (fs.existsSync(p));
    }

    fs.writeFileSync(p, content, 'utf-8');
    if (open) {
        let openPath = vscode.Uri.parse("file:///" + p);
        let doc = await vscode.workspace.openTextDocument(openPath);
        await vscode.window.showTextDocument(doc);
    }
    return;
}

/**
 * Make a valid dart variable name from a string.
 * @param {string} source
 */
function toVarName(source) {
    let s = source;
    let r = '';

	/**
	 * @param {string} char
	 */
    let replace = (char) => {
        if (s.includes(char)) {
            const splits = s.split(char);
            for (let i = 0; i < splits.length; i++) {
                let w = splits[i];
                i > 0 ? r += capitalize(w) : r += w;
            }
        }
    }

    // Replace invalid variable characters like '-'.
    replace('-');
    replace('~');
    replace(':');
    replace('#');
    replace('$');

    if (r.length == 0)
        r = s;

    // Prevent dart keywords from being used.
    switch (r) {
        case 'assert': r = 'aAssert'; break;
        case 'break': r = 'bBreak'; break;
        case 'case': r = 'cCase'; break;
        case 'catch': r = 'cCatch'; break;
        case 'class': r = 'cClass'; break;
        case 'const': r = 'cConst'; break;
        case 'continue': r = 'cContinue'; break;
        case 'default': r = 'dDefault'; break;
        case 'do': r = 'dDo'; break;
        case 'else': r = 'eElse'; break;
        case 'enum': r = 'eEnum'; break;
        case 'extends': r = 'eExtends'; break;
        case 'false': r = 'fFalse'; break;
        case 'final': r = 'fFinal'; break;
        case 'finally': r = 'fFinally'; break;
        case 'for': r = 'fFor'; break;
        case 'if': r = 'iIf'; break;
        case 'in': r = 'iIn'; break;
        case 'is': r = 'iIs'; break;
        case 'new': r = 'nNew'; break;
        case 'null': r = 'nNull'; break;
        case 'rethrow': r = 'rRethrow'; break;
        case 'return': r = 'rReturn'; break;
        case 'super': r = 'sSuper'; break;
        case 'switch': r = 'sSwitch'; break;
        case 'this': r = 'tThis'; break;
        case 'throw': r = 'tThrow'; break;
        case 'true': r = 'tTrue'; break;
        case 'try': r = 'tTry'; break;
        case 'var': r = 'vVar'; break;
        case 'void': r = 'vVoid'; break;
        case 'while': r = 'wWhile'; break;
        case 'with': r = 'wWith'; break;
    }

    if (r.length > 0 && r[0].match(new RegExp(/[0-9]/)))
        r = 'n' + r;

    return r;
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} start
 * @param {number} end
 * @param {string} value
 */
function editorReplace(editor, start = null, end = null, value) {
    editor.replace(new vscode.Range(
        new vscode.Position(start || 0, 0),
        new vscode.Position(end || getDocText().split('\n').length, 1)
    ),
        value
    );
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} at
 * @param {string} value
 */
function editorInsert(editor, at, value) {
    editor.insert(new vscode.Position(at, 0), value);
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} from
 * @param {number} to
 */
function editorDelete(editor, from = null, to = null) {
    editor.delete(
        new vscode.Range(
            new vscode.Position(from || 0, 0),
            new vscode.Position(to || getDocText().split('\n').length, 1)
        )
    );
}

/**
 * @param {number} from
 * @param {number} to
 */
function scrollTo(from = null, to = null) {
    getEditor().revealRange(
        new vscode.Range(
            new vscode.Position(from || 0, 0),
            new vscode.Position(to || 0, 0)
        ),
        0
    );
}

function clearSelection() {
    getEditor().selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
}

/**
 * @param {string} source
 */
function capitalize(source) {
    let s = source;
    if (s.length > 0) {
        if (s.length > 1) {
            return s.substr(0, 1).toUpperCase() + s.substring(1, s.length);
        } else {
            return s.substr(0, 1).toUpperCase();
        }
    }

    return s;
}

/**
 * @param {string} source
 * @param {string} start
 */
function removeStart(source, start) {
    return source.startsWith(start) ? source.substring(start.length, source.length) : source;
}

/**
 * @param {string} source
 * @param {string} end
 */
function removeEnd(source, end) {
    const pos = (source.length - end.length);
    if (source.endsWith(end)) {
        return source.substring(0, pos);
    }
    return source;
}

/**
 * @param {string} source
 */
function indent(source) {
    let r = '';
    for (let line of source.split('\n')) {
        r += '  ' + line + '\n';
    }
    return r.length > 0 ? r : source;
}

/**
 * @param {string} source
 */
function getLineInset(source) {
    let inset = 0;
    for (let char of source) {
        if (char == ' ') inset++;
        else break;
    }
    return inset;
}

/**
* @param {string} source
* @param {string} match
*/
function count(source, match) {
    let count = 0;
    let length = match.length;
    for (let i = 0; i < source.length; i++) {
        let part = source.substr((i * length) - 1, length);
        if (part == match) {
            count++;
        }
    }

    return count;
}

/**
 * @param {string} a
 * @param {string} b
 */
function areStrictEqual(a, b) {
    let x = a.replace(/\s/g, "");
    let y = b.replace(/\s/g, "");
    return x === y;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function removeAll(source, matches) {
    let r = '';
    for (let s of source) {
        if (!matches.includes(s)) {
            r += s;
        }
    }
    return r;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function includesOne(source, matches) {
    for (let match of matches) {
        if (source.includes(match))
            return true;
    }
    return false;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function includesAll(source, matches) {
    for (let match of matches) {
        if (!source.includes(match))
            return false;
    }
    return true;
}

function getEditor() {
    return vscode.window.activeTextEditor;
}

function getDoc() {
    return getEditor().document;
}

function getDocText() {
    return getDoc().getText();
}

function getLangId() {
    return getDoc().languageId;
}

/**
 * @param {string} key
 */
function readSetting(key) {
    return vscode.workspace.getConfiguration().get('dart_data_class_generator.' + key);
}

/**
 * @param {string[]} keys
 */
function readSettings(keys) {
    for (let key of keys) {
        if (readSetting(key)) {
            return true;
        }
    }

    return false;
}

/**
 * @param {string} msg
 */
function showError(msg) {
    vscode.window.showErrorMessage(msg);
}

/**
 * @param {string} msg
 */
function showInfo(msg) {
    vscode.window.showInformationMessage(msg);
}

exports.activate = activate;

function deactivate() { }

module.exports = {
    activate,
    deactivate,
    generateDataClass,
    generateJsonDataClass,
    DartFile,
    DartClass,
    DataClassGenerator,
    JsonReader,
    ClassPart,
    ClassProperty,
    writeFile,
    getCurrentPath,
    toVarName,
    createFileName,
    editorInsert,
    editorReplace,
    editorDelete,
    capitalize,
    scrollTo,
    clearSelection,
    removeEnd,
    indent,
    count,
    areStrictEqual,
    removeAll,
    includesOne,
    includesAll,
    getEditor,
    getDoc,
    getDocText,
    getLangId,
    readSetting,
    showError,
    showInfo
}