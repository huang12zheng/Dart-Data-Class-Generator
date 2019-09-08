# Dart Data Class Generator (Beta)

Create dart data classes easily, fast and without writing boilerplate.

## Features

Dart Data Class Generator adds two new commands to vscode:

## Create data classes based on class properties

![](gif_from_class.gif)

### **How?**

- Create a class with properties.
- Hit **CTRL + P** to open the command dialog.
- Search for **Dart Data Class Generator: Generate from class properties** and hit enter.
- When there are multiple classes in the current file, choose the ones you'd like to create data classes of in the dialog.

>**Note:**  
>If the class is a Widget (Stateless or Stateful), only the constructor will be generated.

## Create data classes based on JSON (beta)

![](gif_from_json.gif)

### **How?**

- Create an **empty dart** file.
- Paste the JSON into that file.
- Hit **CTRL + P** to open the command dialog.
- Search for **Dart Data Class Generator: Generate from JSON** and hit enter.
- Type in a class name in the input dialog. This will be the name of the **top level class**, all other class names will be infered.
- When there are nested objects in the JSON, a dialog will be appear if you want to seperate the classes into multiple files or if all classes should be in the same file.

>**Note:**  
>This feature is still in beta!  
>Many API's return numbers like 0 or 1 as an integer and not as a double. Thus the generator may confuse a value that is usually a double as an int.

## Settings

You can customize the generator to only generate the functions you want.

* `dart_data_class.generate.constructor`: Whether to generate a constructor for a data class.
* `dart_data_class.generate.copyWidth`: Whether to generate a copyWidth function for a data class.
* `dart_data_class.generate.toMap`: Whether to generate a toMap function for a data class.
* `dart_data_class.generate.fromMap`: Whether to generate a fromMap function for a data class.
* `dart_data_class.generate.toJson`: Whether to generate a toJson function for a data class.
* `dart_data_class.generate.fromJson`: Whether to generate a fromJson function for a data class.
* `dart_data_class.generate.toString`: Whether to generate an overriden toString function for a data class.
* `dart_data_class.generate.equality`: Whether to generate an overriden value equality function for a data class.
* `dart_data_class.generate.hashCode`: Whether to generate an overriden hashCode function for a data class.

## Release Notes

### 0.0.1
Initial release (Beta).
