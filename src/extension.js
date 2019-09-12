const vscode = require('vscode');
const fs = require("fs");

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
}

async function generateJsonDataClass() {
    let langId = getLangId();
    if (langId == 'dart') {
        let document = getDocText();
        let lines = document.split('\n');

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
                await reader.commitJson(progress, seperate);
                clearSelection();
                scrollTo(0);
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

async function generateDataClass(text = getDocText(), fromJSON = false) {
    if (getLangId() == 'dart') {
        const generator = new DataClassGenerator(text, null, fromJSON);
        let clazzes = generator.clazzes;
        let issues = [];

        // Reverse clazzes when converting from JSON and clazz length greater than 2 => 
        // dev chose single file option, to make sure classes are inserted in correct
        // order and not reversed.
        if (fromJSON && clazzes.length >= 2) {
            clazzes = clazzes.reverse();
        }

        // Show a prompt if there are more than one classes in the current editor.
        if (clazzes.length >= 2 && !fromJSON) {
            clazzes = await showClassChooser(clazzes);
        }

        console.log(clazzes);

        if (clazzes.length > 0) {
            for (let clazz of clazzes) {
                if (!fromJSON && clazz.isValid && clazz.toReplace.length > 0) {
                    if (!readSetting('override.manual')) {
                        const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                            placeHolder: `Do you want to override changes in ${clazz.name}? Custom changes to the functions may not be preserved!`,
                            canPickMany: false
                        });

                        if (r == null) return;
                        else if (r != 'Yes') clazz.toReplace = [];
                    } else {
                        // When manual overriding is activated.
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
                        clazz.isValid ? clazz.replace(editor, i, fromJSON) : issues.push(clazz);
                    }
                }
            });

            clearSelection();
        } else {
            showError('No convertable dart classes were detected!');
            return null;
        }

        // Show errors that may have occured.
        for (let clazz of issues.reverse()) {
            const msg = clazz.name + ' couldn\'t be converted to a data class: ';
            if (!clazz.hasProperties) showError(msg + 'Class must have at least one property!');
            else if (!clazz.hasEnding) showError(msg + 'Class has no ending!');
            else if (!clazz.uniquePropNames) showError(msg + 'Class doesn\'t have unique property names!');
            else showError(removeEnd(msg, ': ') + '.');
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

    const chosen = await vscode.window.showQuickPick(values, {
        placeHolder: 'Please select the classes you want to generate data classes of.',
        canPickMany: true,
    });

    let result = [];
    if (chosen != null) {
        for (let c of chosen) {
            for (let clazz of clazzez) {
                if (clazz.name == c)
                    result.push(clazz);
            }
        }
    }

    return result;
}

class DartClass {
    constructor() {
        /** @type {string} */
        this.name = null;
        /** @type {string} */
        this.extend = null;
        /** @type {string} */
        this.constr = null;
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
        this.constrDifferent = false;
        this.classContent = '';
        this.toInsert = '';
        /** @type {ClassPart[]} */
        this.toReplace = [];
        this.imports = '';
        this.isArray = false;
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

    get hasEnding() {
        return this.endsAtLine != null;
    }

    get hasProperties() {
        return this.properties.length > 0;
    }

    get fewProps() {
        return this.properties.length <= 3;
    }

    get isValid() {
        return this.classDetected && this.hasEnding && this.hasProperties && this.uniquePropNames;
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
        let r = '';
        let lines = this.classContent.split('\n');

        for (let i = this.endsAtLine - this.startsAtLine; i >= 0; i--) {
            let line = lines[i] + '\n';
            let l = this.startsAtLine + i;
            if (l == this.propsEndAtLine && this.constr != null && !this.hasConstructor) {
                r = this.constr + r;
                r = line + r;
            } else if (l == this.endsAtLine && this.isValid) {
                r = line + r;
                r = this.toInsert + r;
            } else {
                let rp = this.replacementAtLine(l);
                if (rp != null) {
                    if (!r.includes(rp))
                        r = rp + '\n' + r;
                } else {
                    r = line + r;
                }
            }
        }

        if (withImports && this.hasImports) {
            r = this.imports + r;
        }
        return r;
    }

	/**
     * @param {vscode.TextEditorEdit} editor
	 * @param {number} [index]
	 */
    replace(editor, index, fromJSON = false) {
        editorReplace(editor,
            this.startsAtLine - 1,
            this.endsAtLine,
            this.getClassReplacement(false) + (fromJSON ? '\n' : '')
        );

        // If imports need to be inserted, do it at the top of the file.
        if (this.hasImports && index == 0) {
            // If document does not contain dart:... imports, add a line break
            // for proper formatting.
            const doc = getDocText();
            if (this.imports.endsWith('\n\n') && doc.includes("import 'dart:"))
                this.imports = removeEnd(this.imports, '\n');

            editorInsert(editor, 0, this.imports);
        }
    }
}

class ClassProperty {
	/**
	 * @param {String} type
	 * @param {String} name
	 * @param {number} line
	 */
    constructor(type, name, line = 1) {
        this.type = type;
        this.jsonName = name;
        this.name = toVarName(name);
        this.line = line;

        if (name == 'nearestStation') {
            console.log(`${name} ${this.jsonName}`);
        }
    }

    get isList() {
        return this.type.startsWith('List<');
    }

    get listType() {
        if (this.isList) {
            return this.type.replace('List<', '').replace('>', '');
        }

        return this.type;
    }

    get isPrimitive() {
        let t = this.listType;
        return t == 'String' || t == 'num' || t == 'dynamic' || this.isDouble || this.isInt;
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
                case 'dynamic': return "null";
                default: return `${this.type}()`;
            }
        }
    }

    get isInt() {
        return this.listType == 'int';
    }

    get isDouble() {
        return this.listType == 'double';
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
	 */
    constructor(text, clazzes = null, fromJSON = false) {
        this.text = text;
        this.fromJSON = fromJSON;
        this.clazzes = clazzes == null ? this.getClasses() : clazzes;
        this.generateDataClazzes();
    }

	/**
	 * @param {string[]} imps
	 * @param {DartClass} clazz
	 */
    hasOneImport(imps, clazz) {
        for (let imp of imps) {
            const impt = `import '${imp}';`;
            if (this.text.includes(impt) || clazz.imports.includes(impt))
                return true;
        }
        return false;
    }

    generateDataClazzes() {
        for (let clazz of this.clazzes) {
            if (readSetting('constructor'))
                this.insertConstructor(clazz);

            if (!clazz.isWidget) {
                if (readSetting('copyWidth'))
                    this.insertCopyWith(clazz);
                if (readSetting('toMap'))
                    this.insertToMap(clazz);
                if (readSetting('fromMap'))
                    this.insertFromMap(clazz);
                if (readSetting('toJson'))
                    this.insertToJson(clazz);
                if (readSetting('fromJson'))
                    this.insertFromJson(clazz);
                if (readSetting('toString'))
                    this.insertToString(clazz);
                if (readSetting('equality'))
                    this.insertEquality(clazz);
                if (readSetting('hashCode'))
                    this.insertHash(clazz);
            }
        }
    }

    /**
     * @param {string} name
     * @param {string} p
     * @param {DartClass} clazz
     */
    findPart(name, p, clazz) {
        let lines = clazz.classContent.split('\n');
        let curlies = 0;
        let part = new ClassPart(name);
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let lineNum = clazz.startsAtLine + i;

            curlies += count(line, '{');
            curlies -= count(line, '}');

            if (part.startsAt == null && line.trimLeft().startsWith(p.trimLeft())) {
                let singleLine = line.includes('=>');
                if (curlies == 2 || singleLine) {
                    part.startsAt = lineNum;
                    part.current = line + '\n';
                    if (singleLine) {
                        part.endsAt = lineNum;
                    }
                }
            } else if (part.startsAt != null && part.endsAt == null && curlies >= 2) {
                part.current += line + '\n';
            } else if (part.startsAt != null && part.endsAt == null && curlies == 1) {
                part.endsAt = lineNum;
                part.current += line;
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
        if (clazz.hasConstructor) {
            const lines = clazz.constr.split('\n');
            for (let l of lines) {
                if (l.includes(p) && !l.includes('{')) {
                    return l.trim();
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
        let constr = '';
        let startBracket = '({';
        let endBracket = '})';

        if (clazz.constr != null) {
            if (clazz.constr.trimLeft().startsWith('const'))
                constr += 'const ';
            
            // Detect custom constructor brackets and preserve them.
            const fConstr = clazz.constr.replace('const', '').trimLeft();
            if (fConstr.startsWith(clazz.name + '([')) {
                startBracket = '([';
                endBracket = '])';
            } else if (fConstr.startsWith(clazz.name + '({')) {
                startBracket = '({';
                endBracket = '})';
            } else if (fConstr.startsWith(clazz.name + '(')) {
                startBracket = '(';
                endBracket = ')';
            }
        }

        constr += clazz.name + startBracket + '\n';
        if (clazz.isWidget) constr += '  Key key,\n'

        for (let p of clazz.properties) {
            const parameter = `this.${p.name}`
            const fp = this.findConstrParameter(parameter, clazz);
            constr += `  ${fp == null ? `${parameter}${defVal && (p.isPrimitive || p.isList) ? ` = ${p.defValue}` : ''}` + ',' : fp}\n`;
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
        let method = clazz.name + ' copyWith({\n';
        for (let p of clazz.properties) {
            method += '  ' + p.type + ' ' + p.name + ',\n';
        }
        method += '}) {\n';
        method += '  return ' + clazz.name + '(\n';

        for (let p of clazz.properties) {
            method += `    ${clazz.hasNamedConstructor ? `${p.name}: ` : ''}${p.name} ?? this.${p.name},\n`;
        }

        method += '  );\n'
        method += '}';

        this.appendOrReplace('copyWith', method, `${clazz.name} copyWith(`, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToMap(clazz) {
        let props = clazz.properties;
        let method = `Map<String, dynamic> toMap() {\n`;
        method += '  return {\n';
        for (let p of props) {
            method += `    '${p.jsonName}': `;
            if (!p.isList) {
                method += `${p.name}${!p.isPrimitive ? '.toMap()' : ''},\n`;
            } else {
                method += `List<dynamic>.from(${p.name}.map((x) => `;
                if (p.isPrimitive) {
                    method += 'x)),\n';
                } else {
                    method += 'x.toMap())),\n';
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
        let method = 'static ' + clazz.name + ' fromMap(Map<String, dynamic> map) {\n';
        method += '  if (map == null) return null;\n\n';
        method += '  return ' + clazz.name + '(\n';
        for (let p of props) {
            method += `    ${clazz.hasNamedConstructor ? `${p.name}: ` : ''}`;
            if (!p.isList) {
                method += `${!p.isPrimitive ? p.type + '.fromMap(' : ''}map['${p.jsonName}']${!p.isPrimitive ? ')' : ''}${this.fromJSON ? (p.isDouble ? '?.toDouble()' : p.isInt ? '?.toInt()' : '') : ''}${defVal ? ` ?? ${p.defValue}` : ''},\n`;
            } else {
                method += `${p.type}.from(`;
                if (p.isPrimitive) {
                    method += `map['${p.jsonName}']${defVal ? ' ?? []' : ''}),\n`;
                } else {
                    method += `map['${p.jsonName}']?.map((x) => ${p.listType}.fromMap(x))${defVal ? ' ?? []' : ''}),\n`;
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
        if (!this.hasOneImport(['dart:convert'], clazz)) {
            clazz.imports += "import 'dart:convert';\n"
        }

        if (clazz.classContent.includes('String toJson()')) return;
        let method = 'String toJson() => json.encode(toMap());';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertFromJson(clazz) {
        if (!this.hasOneImport(['dart:convert'], clazz)) {
            clazz.imports += "import 'dart:convert';\n"
        }

        if (clazz.classContent.includes(`static ${clazz.name} fromJson(`)) return;
        let method = `static ${clazz.name} fromJson(String source) => fromMap(json.decode(source));`;
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToString(clazz) {
        let short = clazz.fewProps;
        let props = clazz.properties;
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
        let props = clazz.properties;
        let method = '@override\n';
        method += 'bool operator ==(Object o) {\n';
        method += '  return o is ' + clazz.name + ' &&\n';
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
        if (!this.hasOneImport([
            'dart:ui',
            'package:flutter/material.dart',
            'package:flutter/cupertino.dart',
            'package:flutter/widgets.dart'
        ], clazz)) {
            clazz.imports += "import 'dart:ui';\n\n";
        }

        let props = clazz.properties;
        let method = '@override\n';
        method += 'int get hashCode {\n';
        method += '  return hashList([\n';
        for (let p of props) {
            method += '    ' + p.name + `,\n`;
        }
        method += '  ]);\n';
        method += '}';

        this.appendOrReplace('hashCode', method, 'int get hashCode', clazz);
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
        let clazz = new DartClass();

        let lines = this.text.split('\n');
        let curlyBrackets = 0;
        let brackets = 0;

        for (var x = 0; x < lines.length; x++) {
            let line = lines[x];
            let linePos = x + 1;
            let classLine = line.trimLeft().includes('class');

            if (classLine) {
                clazz = new DartClass();
                clazz.startsAtLine = linePos;

                let classNext = false;
                let extendsNext = false;

                for (let word of line.split(' ')) {
                    if (word.length > 0 && word != '{') {
                        if (word.endsWith('{', word.length - 1))
                            word = word.substr(0, word.length - 1);

                        if (word == 'class') classNext = true;
                        else if (classNext) {
                            classNext = false;
                            clazz.name = word;
                        } else if (word == 'extends') extendsNext = true;
                        else if (extendsNext) {
                            extendsNext = false;
                            clazz.extend = word;
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

                if (!clazz.hasConstructor && curlyBrackets == 1) {
                    const lineValid = !line.trimLeft().startsWith(clazz.name) && !includesOne(line, ['static', '=', '(', ')', '{', '@']);
                    if (lineValid) {
                        let type = null;
                        let name = null;

                        for (let word of line.split(' ')) {
                            if (word.length > 0 && word != '}' && word != '{') {
                                // Be sure to not include keywords.
                                if (word != 'final' && word != 'const') {
                                    // If word ends with semicolon => variable name, else type.
                                    let variable = word.trim().endsWith(';');
                                    variable ? name = removeEnd(word.trim(), ';') : type = word;
                                }
                            }
                        }

                        if (type != null && name != null) {
                            clazz.properties.push(new ClassProperty(type, name, linePos));
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

                // Detect end of class.
                clazz.classContent += line;
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
            return 'The provided JSON is malformed or could\'nt be parsed!';
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
                        if (k.endsWith('ies')) k = removeEnd(k, 'ies') + 'y';
                        if (k.endsWith('s')) k = removeEnd(k, 's');
                        const i0 = this.getPrimitive(value[0]);

                        if (i0 == null) {
                            this.getClazzes(value[0], k);
                            type = 'List<' + capitalize(k) + '>';
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
    fillGenImports(clazz) {
        let imports = '';
        let hasGenType = false;
        for (let cp of clazz.properties) {
            // Import only inambigous generated types.
            // E.g. if there are multiple generated classes with
            // the same name, do not include an import of that class.
            if (this.getGeneratedTypeCount(cp.listType) == 1) {
                hasGenType = true;
                let imp = `import '${createFileName(cp.listType)}.dart';\n`;
                clazz.imports += imp;
                imports += imp;
            }
        }

        if (hasGenType) {
            imports += '\n';
            clazz.imports += '\n';
        }

        return imports.length > 0 ? imports : null;
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
                this.fillGenImports(clazz)

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
                    f += clazz.getClassReplacement(false) + '\n';
                }

                if (isLast) {
                    f = removeEnd(f, '\n\n');
                    await getEditor().edit(editor => {
                        editorReplace(editor, 0, null, f);
                        editorInsert(editor, 0, file.clazz.imports);
                    });
                }
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
 * @param {string} end
 */
function removeEnd(source, end) {
    const pos = (source.length - end.length);
    if (source.endsWith(end)) {
        let s = source.substring(0, pos);
        return s;
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
    deactivate
}