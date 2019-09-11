# Dart Data Class Generator (Beta)

Create dart data classes easily, fast and without writing boilerplate or running code generation.  

## Features

The generator can generate the constructor, copyWidth, toMap, fromMap, toJson, fromJson, toString, value equality and hashCode methods from a class or a JSON.

Dart Data Class Generator adds two new commands to vscode:

## Create data classes based on class properties

![](gif_from_class.gif)

### **How?**

- Create a class with properties.
- Hit **CTRL + P** to open the command dialog.
- Search for **Dart Data Class Generator: Generate from class properties** and hit enter.
- When there are multiple classes in the current file, choose the ones you'd like to create data classes of in the dialog.

It is also possible to run the command on an existing data class (e.g. when some parameters changed). The generator will then try 
to find the changes and update the class. **Note that this feature is still in beta and custom changes you made to a method may not be preserved.**

**Note:**  
**If the class is a Widget (Stateless or Stateful), only the constructor will be generated. State classes wont be detected.**  

## Create data classes based on JSON (beta)

![](gif_from_json.gif)

### **How?**

- Create an **empty dart** file.
- Paste the **raw JSON** into the otherwise empty file.
- Hit **CTRL + P** to open the command dialog.
- Search for **Dart Data Class Generator: Generate from JSON** and hit enter.
- Type in a class name in the input dialog. This will be the name of the **top level class**, all other class names will be infered.
- When there are nested objects in the JSON, a dialog will be appear if you want to seperate the classes into multiple files or if all classes should be in the same file.

**Note:**  
**This feature is still in beta!**  
**Many API's return numbers like 0 or 1 as an integer and not as a double even when they otherwise are. Thus the generator may confuse a value that is usually a double as an int. The generator calls toDouble() or toInt() when mapping from JSON to prevent crashes, however you should account for this either before running the generator in the JSON or in the generated classes afterwards themselves.**  

## Settings

You can customize the generator to only generate the functions you want in your settings file.

* `dart_data_class_generator.generate.default_values`: If true, checks if a field is null when deserializing and provides a non-null default value.
* `dart_data_class_generator.json.seperate`: Whether to seperate a JSON into multiple files, when the JSON contains nested objects. ask: choose manually every time, seperate: always seperate into multiple files, current_file: always insert all classes into the current file.
* `dart_data_class_generator.class.manual_override`: If true, asks, when overriding a class (running the command on an existing class), for every single function/constructor that needs to be changed whether the generator should override the function or not. This allows you to preserve custom changes you made to the function/constructor that would be otherwise overwritten by the generator.
* `dart_data_class_generator.generate.constructor`: If true, generates a constructor for a data class.
* `dart_data_class_generator.generate.copyWidth`: If true, generates a copyWidth function for a data class.
* `dart_data_class_generator.generate.toMap`: If true, generates a toMap function for a data class.
* `dart_data_class_generator.generate.fromMap`: If true, generates a fromMap function for a data class.
* `dart_data_class_generator.generate.toJson`: If true, generates a toJson function for a data class.
* `dart_data_class_generator.generate.fromJson`: If true, generates a fromJson function for a data class.
* `dart_data_class_generator.generate.toString`: If true, generates a toString function for a data class.
* `dart_data_class_generator.generate.equality`: If true, generates a value equality function for a data class.
* `dart_data_class_generator.generate.hashCode`: If true, generates a hashCode function for a data class.

## Release Notes

### 0.0.1
Initial release (Beta).
