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
        let document = getDocumentText();
        let lines = document.split('\n');

        const name = await vscode.window.showInputBox({
            placeHolder: 'Please type in a class name.'
        });

        if (name == null || name.length == 0) {
            showError('Name must be specified!');
            return;
        }

        let reader = new JsonReader(document, name);
        let seperate = true;

        if (!(await reader.isJsonMalformed)) {
            if (reader.files.length >= 2) {
                const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                    canPickMany: false,
                    placeHolder: 'Do you wish to seperate the JSON into multiple files?'
                });
                seperate = r == 'Yes';
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                cancellable: false
            }, function (progress, token) {
                progress.report({ increment: 0, message: 'Generating Data Classes...' });
                return new Promise(resolve => {
                    vscode.window.activeTextEditor.edit(editor => {
                        editor.replace(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lines.length + 1, 0)), reader.files[0].content);
                        setTimeout(async () => {
                            await reader.writeFiles(progress, seperate);
                            resolve();
                        }, 300);
                    });
                });
            });
        } else {
            showError("The provided JSON is malformed or couldn't be parsed!");
        }
    } else if (langId == 'json') {
        showError('Please paste the JSON directly into an empty .dart file and then try again!');
    } else {
        showError('Make sure that you\'re editing a dart file and then try again!');
    }
}

async function generateDataClass(text = getDocumentText(), fromJSON = false) {
    if (getLangId() == 'dart') {
        let generator = new DataClassGenerator(text, null, fromJSON);
        let clazzes = generator.clazzes;
        let issues = [];

        // Show a prompt if there are more than one classes in the current editor.
        if (clazzes.length >= 2 && !fromJSON) {
            clazzes = await showClassChooser(clazzes);
        }

        console.log(clazzes);

        if (clazzes.length > 0) {
			/** 
			* @param {vscode.TextEditor} editor
			*/
            await vscode.window.activeTextEditor.edit(async (editor) => {
                for (let i = clazzes.length - 1; i >= 0; i--) {
                    const clazz = clazzes[i];
                    clazz.isValid ? clazz.replace(editor, i) : issues.push(clazz);
                }
            });
        } else {
            showError('No dart classes were detected!');
            return null;
        }

        // Show errors that may have occured.
        for (let clazz of issues.reverse()) {
            let msg = clazz.name + ' couldn\'t be converted to a data class: ';
            if (!clazz.hasProperties) showError(msg + 'Class must have at least one property!');
            else if (!clazz.hasEnding) showError(msg + 'Class has no ending!');
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
    let values = clazzez.map((v) => v.name);

    let chosen = await vscode.window.showQuickPick(values, {
        placeHolder: 'Please select the classes you want to generate data classes of.',
        canPickMany: true,
    });

    let result = [];
    for (let c of chosen) {
        for (let clazz of clazzez) {
            if (clazz.name == c)
                result.push(clazz);
        }
    }

    return result;
}

class DartClass {
	/**
	 * @param {String} name
	 * @param {String} extend
	 * @param {String} constr
	 * @param {ClassProperty[]} properties
	 * @param {number} startsAtLine
	 * @param {number} endsAtLine
	 * @param {number} constrStartsAtLine
	 * @param {number} constrEndsAtLine
	 * @param {String} classContent
	 * @param {String} imports
	 */
    constructor(name = null, extend = null, constr = null, properties = [], startsAtLine = -1, endsAtLine = -1, constrStartsAtLine = -1, constrEndsAtLine = -1, classContent = '', toInsert = '', imports = '') {
        this.name = name;
        this.extend = extend;
        this.constr = constr;
        this.properties = properties;
        this.startsAtLine = startsAtLine;
        this.endsAtLine = endsAtLine;
        this.constrStartsAtLine = constrStartsAtLine;
        this.constrEndsAtLine = constrEndsAtLine;
        this.classContent = classContent;
        this.toInsert = toInsert;
        this.imports = imports;
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
        return this.startsAtLine != -1;
    }

    get hasConstructor() {
        return this.constrStartsAtLine != -1 && this.constrEndsAtLine != -1;
    }

    get hasEnding() {
        return this.endsAtLine != -1;
    }

    get hasProperties() {
        return this.properties.length > 0;
    }

    get isValid() {
        return this.classDetected && this.hasEnding && this.hasProperties;
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

    getClassReplacement(imports = true) {
        let r = '';
        let lines = this.classContent.split('\n');
        if (imports && this.hasImports) {
            r += this.imports;
        }

        for (let i = 0; i <= (this.endsAtLine - this.startsAtLine); i++) {
            let line = lines[i] + '\n';
            let l = this.startsAtLine + i;
            if (l == this.propsEndAtLine && this.constr != null && !this.hasConstructor) {
                r += line;
                r += this.constr;
            } else if (l == this.endsAtLine && this.isValid) {
                r += this.toInsert;
                r += line;
            } else {
                r += line;
            }
        }
        return r;
    }

	/**
	 * @param {vscode.TextEditorEdit} editor
	 * @param {number} [index]
	 */
    replace(editor, index) {
        editor.replace(
            new vscode.Range(
                new vscode.Position(this.startsAtLine - 1, 0),
                new vscode.Position(this.endsAtLine, 1)
            ), this.getClassReplacement(false));

        // If imports need to be inserted, do it at the top of the file.
        if (this.hasImports && index == 0) {
            editor.insert(new vscode.Position(0, 0), this.imports);
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

    get isInt() {
        return this.listType == 'int';
    }

    get isDouble() {
        return this.listType == 'double';
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
	 * @param {string} imp
	 */
    hasImport(imp) {
        return this.text.includes('import ' + "'" + imp + "';");
    }

    generateDataClazzes() {
        for (let clazz of this.clazzes) {
            if (includeFunction('constructor'))
                this.insertConstructor(clazz);

            if (!clazz.isWidget) {
                if (includeFunction('copyWidth'))
                    this.insertCopyWidth(clazz);
                if (includeFunction('toMap'))
                    this.insertToMap(clazz);
                if (includeFunction('fromMap'))
                    this.insertFromMap(clazz);
                if (includeFunction('toJson'))
                    this.insertToJson(clazz);
                if (includeFunction('fromJson'))
                    this.insertFromJson(clazz);
                if (includeFunction('toString'))
                    this.insertToString(clazz);
                if (includeFunction('equality'))
                    this.insertEquality(clazz);
                if (includeFunction('hashCode'))
                    this.insertHash(clazz);
            }
        }
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertConstructor(clazz) {
        if (clazz.hasConstructor) return;
        let constr = clazz.name + '({\n';

        if (clazz.isWidget) {
            constr += '  Key key,\n'
            if (clazz.isStatelessWidget)
                constr = 'const ' + constr;
        }

        for (let p of clazz.properties) {
            constr += `  this.${p.name},\n`;
        }
        constr += '})' + (clazz.isWidget ? ' : super(key: key);' : ';');
        this.append(constr, clazz, true);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertCopyWidth(clazz) {
        if (clazz.classContent.includes('copyWidth')) return;

        let method = clazz.name + ' copyWidth({\n';
        for (let p of clazz.properties) {
            method += '  ' + p.type + ' ' + p.name + ',\n';
        }
        method += '}) {\n';
        method += '  return ' + clazz.name + '(\n';

        for (let p of clazz.properties) {
            method += '    ' + p.name + ': ' + p.name + ' ?? this.' + p.name + ',\n';
        }

        method += '  );\n'
        method += '}';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToMap(clazz) {
        if (clazz.classContent.includes('Map<String, dynamic> toMap()')) return;

        let props = clazz.properties;
        let method = 'Map<String, dynamic> toMap() {\n';
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
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertFromMap(clazz) {
        if (clazz.classContent.includes('fromMap(Map<String, dynamic> map)')) return;

        let props = clazz.properties;
        let method = 'static ' + clazz.name + ' fromMap(Map<String, dynamic> map) {\n';
        method += '  return ' + clazz.name + '(\n';
        for (let p of props) {
            method += `    ${p.name}: `;
            if (!p.isList) {
                method += `${!p.isPrimitive ? p.type + '.fromMap(' : ''}map['${p.jsonName}']${!p.isPrimitive ? ')' : ''}${this.fromJSON ? (p.isDouble ? '.toDouble()' : p.isInt ? '.toInt()' : '') : ''},\n`;
            } else {
                method += `${p.type}.from(map['${p.jsonName}'].map((x) => `;
                if (p.isPrimitive) {
                    method += `x${this.fromJSON ? (p.isDouble ? '.toDouble()' : p.isInt ? '.toInt()' : '') : ''})),\n`;
                } else {
                    method += `${p.listType}.fromMap(x))),\n`;
                }
            }
            if (p.name == props[props.length - 1].name) method += '  );\n';
        }
        method += '}';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToJson(clazz) {
        if (clazz.classContent.includes('String toJson()')) return;
        if (!this.hasImport('dart:convert') && !clazz.imports.includes('dart:convert')) {
            clazz.imports += "import 'dart:convert';\n"
        }

        let method = 'String toJson() => json.encode(toMap());';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertFromJson(clazz) {
        if (clazz.classContent.includes('fromJson(')) return;
        if (!this.hasImport('dart:convert') && !clazz.imports.includes('dart:convert')) {
            clazz.imports += "import 'dart:convert';\n"
        }

        let method = 'static ' + clazz.name + ' fromJson(String source) => fromMap(json.decode(source));';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertToString(clazz) {
        if (clazz.classContent.includes('String toString()')) return;

        let props = clazz.properties;
        let method = '@override\n';
        method += 'String toString() {\n';
        method += "  return '" + clazz.name;
        for (let p of props) {
            method += ' ' + p.name + ': $' + p.name + ',';
            if (p.name == props[props.length - 1].name) {
                method = removeEnd(method, ',');
                method += "';\n";
            }
        }
        method += '}';
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertEquality(clazz) {
        if (clazz.classContent.includes('bool operator ==')) return;

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
        this.append(method, clazz);
    }

	/**
	 * @param {DartClass} clazz
	 */
    insertHash(clazz) {
        if (clazz.classContent.includes('int get hashCode')) return;

        if (!(this.hasImport('dart:ui') || this.hasImport('package:flutter/material.dart') || this.hasImport('package:flutter/cupertino.dart') || this.hasImport('package:flutter/widgets.dart'))) {
            clazz.imports += "import 'dart:ui';\n\n";
        }

        let props = clazz.properties;
        let method = '@override\n';
        method += 'int get hashCode {\n';
        method += '  return hashList([\n';
        for (let p of props) {
            method += '    ' + p.name + ',\n';
        }
        method += '  ]);\n';
        method += '}';
        this.append(method, clazz);
    }

	/**
	 * @param {string} method
	 * @param {DartClass} clazz
	 */
    append(method, clazz, constr = false) {
        let met = '';
        for (let line of method.split('\n')) {
            met += '  ' + line + '\n';
        }

        if (constr) {
            clazz.constr = met;
        } else {
            clazz.toInsert += '\n' + met;
        }
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
                clazz.startsAtLine = x + 1;

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
                    let lineValid = !line.trimLeft().startsWith(clazz.name) && !(line.includes('(') || line.includes(')') || line.includes('{') || line.includes('@'));
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
                let includesConstr = line.includes(name + '({') || line.includes(name + '([');
                if (includesConstr && !classLine) {
                    clazz.constrStartsAtLine = linePos;
                }

                // Detect end of constructor.
                if (clazz.constrEndsAtLine == -1 && clazz.constrStartsAtLine != -1 && brackets == 0) {
                    clazz.constrEndsAtLine = linePos;
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
        this.isJsonMalformed = this.generateFiles();
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
        this.clazzes.push(clazz);

        let i = 1;
        clazz.classContent += 'class ' + clazz.name + ' {\n';
        for (let key in object) {
            let value = object[key];
            let type = this.getPrimitive(value);

            if (type == null) {
                if (value instanceof Array) {
                    if (value.length > 0) {
                        let k = key;
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
                    this.getClazzes(value, key);
                    type = capitalize(key);
                }
            }

            clazz.properties.push(new ClassProperty(type, key, ++i));
            clazz.classContent += '  final ' + type + ' ' + toVarName(key) + ';\n';
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
    fillImports(clazz) {
        let imports = '';
        let hasGenType = false;
        for (let cp of clazz.properties) {
            // Import only unambigous generated types.
            // E.g. if there are multiple generated classes with
            // the same name, do not include an import of that class.
            let typeCount = this.getGeneratedTypeCount(cp.listType);
            if (typeCount == 1) {
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
    async writeFiles(progress, seperate) {
        let path = getCurrentPath();
        let f = '';

        const length = this.files.length;
        for (let i = 0; i < length; i++) {
            const file = this.files[i];
            if (seperate) {
                progress.report({
                    increment: ((1 / length) * 100),
                    message: `Creating file ${file.name}...`
                });

                if (i > 0) {
                    let generator = new DataClassGenerator(file.content, [file.clazz], true);
                    for (let clazz of generator.clazzes) {
                        this.fillImports(clazz)
                        await writeFile(clazz.getClassReplacement(), file.name, false, path);
                    }
                } else {
                    let clazzes = await generateDataClass(file.content, true);
                    if (clazzes != null) {
                        let imports = this.fillImports(file.clazz);
                        if (imports != null) {
                            let lines = clazzes[0].imports.split('\n').length - 1;
                            await getEditor().edit((editor) => {
                                editor.insert(new vscode.Position(lines, 0), imports);
                            });
                        }
                    }
                }

                // Slow the writing process intentionally down.
                await new Promise(resolve => setTimeout(() => {
                    resolve();
                }, 120));
            } else {
                f += file.content;
                if (i == length - 1) {
                    await generateDataClass(f, true);
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
    let replace = function (char) {
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

    if (r == 'return')
        r = 'rReturn';
    if (r == 'final')
        r = 'fFinal';
    if (r == 'const')
        r = 'cConst';
    if (r.length > 0 && r[0].match(new RegExp(/[0-9]/)))
        r = 'n' + r;

    return r;
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

function getEditor() {
    return vscode.window.activeTextEditor;
}

function getDocument() {
    return getEditor().document;
}

function getDocumentText() {
    return getDocument().getText();
}

function getLangId() {
    return getDocument().languageId;
}

/**
 * @param {string} key
 */
function includeFunction(key) {
    return readSetting('dart_data_class.generate.' + key) == true;
}

/**
 * @param {string} key
 */
function readSetting(key) {
    return vscode.workspace.getConfiguration().get(key);
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
