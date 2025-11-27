import os
import io
import argparse
import json

skipFiles = [
    "manifest.json.template",
    "test",
    "moz.build",
]

def getFullFileList(outputLoc, dirName):
    result = {dirName: []}
    for entry in os.listdir(outputLoc):
        if entry in skipFiles:
            continue
        if os.path.isdir(os.path.join(outputLoc, entry)):
            result.update(getFullFileList(os.path.join(outputLoc, entry), os.path.join(dirName, entry)))
        elif dirName:
            result[dirName].append(os.path.join(dirName, entry))
        else:
            result[dirName].append(entry)

    return result

def rewriteMozBuild(outputLoc, fileList, extension_id):
    mozBuildFile = os.path.join(outputLoc, "moz.build")
    print("Rewriting %s" % mozBuildFile)

    with io.open(mozBuildFile, "w", encoding="UTF-8") as buildFile:
        insertion_text = ''

        for dir in sorted(fileList.keys()):
            if not fileList[dir]:
                continue

            if not dir:
                mozBuildPathName = ""
            else:
                mozBuildPathName = '["' + '"]["'.join(dir.split(os.sep)) + '"]'

            sorted_files = sorted(fileList[dir], key=lambda s: s.lower())  # Sort the files

            insertion_text += \
                "FINAL_TARGET_FILES.features['%s']%s += [\n" % (extension_id, mozBuildPathName) + \
                "  '" + \
                "',\n  '".join(sorted_files) + "'\n]\n\n"  # Use the sorted files

        new_contents = "# AUTOMATIC INSERTION START\n" + insertion_text + "# AUTOMATIC INSERTION END\n"
        buildFile.write(new_contents)

def replace_locale_strings_in_manifest(manifest_path, locale_path):
    # Load the manifest file
    with open(manifest_path, 'r') as f:
        manifest_data = json.load(f)

    # Load the messages file
    with open(locale_path, 'r') as f:
        messages_data = json.load(f)

    # Recursive function to replace placeholders in nested objects
    def replace_placeholders(obj):
        if isinstance(obj, dict):
            for key in obj:
                obj[key] = replace_placeholders(obj[key])
        elif isinstance(obj, str) and obj.startswith('__MSG_') and obj.endswith('__'):
            # Extract the message key from the placeholder
            message_key = obj[6:-2]

            # Replace the placeholder with the message from the messages file
            if message_key in messages_data:
                return messages_data[message_key]['message']
        return obj

    # Replace placeholders in the manifest data
    manifest_data = replace_placeholders(manifest_data)

    # Write the modified manifest data back to the file
    with open(manifest_path, 'w') as f:
        json.dump(manifest_data, f, indent=2)

def main(directory, extension_id):
    outputLoc = directory
    fileList = getFullFileList(outputLoc, "")
    rewriteMozBuild(outputLoc, fileList, extension_id)

    # Call the function with the paths to the manifest.json and messages.json files
    manifest_path = os.path.join(directory, 'manifest.json')
    locale_path = os.path.join(directory, '_locales', 'en', 'messages.json')
    if os.path.exists(manifest_path) and os.path.exists(locale_path):
        replace_locale_strings_in_manifest(manifest_path, locale_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate moz.build file")
    parser.add_argument("directory", help="The directory to list files for")
    parser.add_argument("extension_id", help="The ID of the extension")
    args = parser.parse_args()
    main(args.directory, args.extension_id)