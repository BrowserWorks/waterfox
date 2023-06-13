# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"""Runs the macOS codesign(1) command on a directory tree

This script runs the codesign(1) command on a directory tree as
specified by a provided JSON mappings file referred to as a map file.
The function codesigntree does the bulk of the work and is written
to be reused when the code is included as a module. The format of the
JSON map file is as follows.

Each entry in the json["map"] array corresponds to one invocation of
the codesign command and is represented as a dictionary whose key value pairs
control the options used. A subset of codesign CLI arguments can be configured
including "--deep", "--option runtime", "--force", "--requirements",
and "--entitlement <file>" arguments. The files to be codesigned are specified
in the dictionary using a glob pattern.

    {
        "map" : [
        {
          "deep"         : <boolean>,
          "runtime"      : <boolean>,
          "force"        : <boolean>,
          "sign"         : [<one or zero keychain names to pass
                             to the codesign command>]
          "keychain"     : [<one or zero keychain names to pass
                             to the codesign command>]
          "requirements" : [<one or zero requirement strings to pass
                             to the codesign command>]
          "entitlements" : [<one or zero entitlement filenames all
                            from the same directory>],
          "globs"        : [<one or more glob filename patterns
                            relative to a root directory provided
                            to the script>]
        }
        {
          "deep"         : <boolean>,
          "runtime"      : <boolean>,
          "force"        : <boolean>,
          "sign"         : [<string>]
          "keychain"     : [],
          "requirements" : [],
          "entitlements" : [],
          "globs"        : [<...>, <...>, <...>, ...]
        }
        ...
        ]
    }

For example,

    {
        "map" : [
        {
          "deep"         : false,
          "runtime"      : true,
          "force"        : true,
          "sign"         : [], # must be passed on command line if empty
          "keychain"     : [], # optional
          "requirements" : [], # optional
          "entitlements" : [default.xml],
          "globs"        : [
            "/Contents/MacOS/XUL",
            "/Contents/MacOS/pingsender",
            "/Contents/MacOS/minidump-analyzer",
            "/Contents/MacOS/*.dylib"
          ]
        }
    }

Note:

  1) Each "map" array entry represents one invocation of the codesign
     command which is executed preserving the order of the input file
     and includes all files matching all the glob patterns from the
     "globs" entry.

  2) The sign, keychain, requirements, and entitlements array must either
     be empty [] or contain a single string ["foo"].

        The entitlements entry should contain a filename for an
        entitlements file contained in the entitlements directory
        passed to the script.

     Some of the values specified in the map file can be overriden
     with values passed on the command line. See ALLOWED_OVERRIDE_KEYS
     in the source below for which options can be overriden.

  3) The globs array must contain one or more filename glob patterns
     which must each start with a "/" representing the root directory
     The files matching each glob entry are input to the codesign
     command in order.

"""

import argparse
import glob
import json
import logging
import os
import subprocess
import sys
import tempfile
import zipfile

REQUIRED_MAP_FILE_KEYS = ["force", "sign", "deep", "runtime", "entitlements",
        "globs", "keychain", "requirements"]

ALLOWED_OVERRIDE_KEYS = ["force", "sign", "runtime", "entitlements",
        "keychain", "requirements"]

def main():
    parser = argparse.ArgumentParser()

    parser.add_argument("-v", "--verbose", action="store_true",
            help="print information about arguments and the codesign " +
            "commands to be executed", default=False)

    parser.add_argument("-n", "--simulate", action="store_true",
            help="don't do anything, just print codesign commands")

    parser.add_argument("-m", "--map-file", type=str, required=True,
            help="the JSON codesigning map file path")

    parser.add_argument("-d", "--ent-dir", type=str, required=True,
            help="the entitlement file directory")

    parser.add_argument("-z", "--ent-zip-file", type=str, required=False,
            help="a zip file containing entitlement and map files. "
            "When used, the provided entitlement directory and map files "
            "will be read from the zip file and the -m/--map-file and "
            "-d/--ent-dir options must be relative paths (relative to the "
            "root of the zip file)")

    parser.add_argument("-r", "--root-dir", type=str, required=True,
            help="the root dir, e.g., /Users/me/MyApp.app")

    # Overrides. We depend on the --long option name matching the override
    # key in ALLOWED_OVERRIDE_KEYS. i.e., --sign => "sign" override.
    parser.add_argument("-s", "--sign", type=str,
            help="the codesigning identity to use for all codesign " +
            "commands (overrides map file)")

    parser.add_argument("-f", "--force", action="store_true", default=None,
            help="apply the force flag to all codesign commands to " +
            "replace any existing signatures (overrides map file)")

    parser.add_argument("-u", "--runtime", action="store_true", default=None,
            help="enable hardened runtime for all codesign commands " +
            "(overrides map file)")

    parser.add_argument("-k", "--keychain", type=str, required=False,
            help="the keychain to use for all codesign commands " +
            "(overrides map file)")

    parser.add_argument("-q", "--requirements", type=str, required=False,
            help="the requirements string to use for all codesign commands " +
            "(overrides map file)")

    parser.add_argument("-t", "--entitlements", type=str, required=False,
            help="the entitlements file from the entitlements dir " +
            "to use for all codesign commands (overrides map file)")

    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    logger = logging.getLogger('codesign')

    temp_dir = None
    map_file_unchecked = args.map_file
    ent_dir_unchecked = args.ent_dir

    # if a zip file was provided, unzip it and get a path to
    # the entitlements directory and the map file. Overwrite
    # the map file and entitlement dir args with paths from
    # the extract zip file.
    if args.ent_zip_file:
        if not zipfile.is_zipfile(args.ent_zip_file):
            logger.error("Invalid Zip file: \"%s\"" % args.ent_zip_file)
            sys.exit(-1)

        # create a temporary directory to unzip to. This is
        # automatically deleted. Use tempfile.mkdtemp instead
        # to prevent auto delete.
        temp_dir = tempfile.TemporaryDirectory()
        logger.debug("Using temp dir \"%s\" to unzip \"%s\"" %
            (temp_dir.name, args.ent_zip_file))

        # unzip the file to the temporary directory
        zf = zipfile.ZipFile(args.ent_zip_file)
        try:
            zf.extractall(temp_dir.name);
        except Exception as e:
            logger.error("Error unzipping \"%s\"" % args.ent_zip_file)
            logger.error(e)
            sys.exit(-1)

        if args.verbose:
            zip_file_basename = os.path.basename(args.ent_zip_file)
            file_list = zf.namelist()
            file_list.sort()
            for file in file_list:
                logger.debug(zip_file_basename + ":" + file)

        # check map file argument is a relative path
        if os.path.isabs(args.map_file):
            logger.error("Invalid map file: \"%s\"" % args.map_file)
            logger.error("Map file argument must be a relative path when "
                    "a zip file is used.");
            sys.exit(-1)

        # build path to the unzipped map file
        map_file_unchecked = os.path.join(temp_dir.name, args.map_file)

        # check entitlement dir argument is a relative path
        if os.path.isabs(args.ent_dir):
            logger.error("Invalid entitlements directory: \"%s\"" %
                    (args.ent_dir))
            logger.error("Entitlements directory argument must be a relative "
                "path when a zip file is used.");
            sys.exit(-1)

        # build path to the unzipped entitlements dir
        ent_dir_unchecked = os.path.join(temp_dir.name, args.ent_dir)

    # check map file
    if not os.path.exists(map_file_unchecked):
        logger.error("Invalid map file: \"%s\"" % map_file_unchecked)
        sys.exit(-1)
    if not os.access(map_file_unchecked, os.R_OK):
        logger.error("Map file read access error:\"%s\"" % map_file_unchecked)
        sys.exit(-1)
    map_file = os.path.realpath(map_file_unchecked)

    # check entitlement dir
    if not os.path.isdir(ent_dir_unchecked):
        logger.error("Invalid entitlements directory: \"%s\"" %
                (ent_dir_unchecked))
        sys.exit(-1)
    ent_dir = os.path.realpath(ent_dir_unchecked)
    ent_dir = ent_dir.rstrip("/")

    # check root dir
    if not os.path.isdir(args.root_dir):
        logger.error("Invalid root directory: \"%s\"" % (args.root_dir))
        sys.exit(-1)
    root_dir = os.path.realpath(args.root_dir)
    root_dir = root_dir.rstrip("/")

    if args.verbose:
        logger.info("JSON map file:          %s" % map_file);
        logger.info("Entitlement directory:  %s" % ent_dir);
        logger.info("Root directory:         %s" % root_dir);
        logger.info("Codesigning identity:   %s" % args.sign);

    overrides = {}
    for key in ALLOWED_OVERRIDE_KEYS:
        override_arg_key = getattr(args, key)
        if override_arg_key is not None:
            logger.info("Override:               %s: %s" %
                    (key,override_arg_key));
            overrides[key] = override_arg_key

    exit_code = 0
    if not codesigntree(map_file, root_dir, ent_dir, overrides,
            args.simulate, args.verbose, logger):
        exit_code = -1

    sys.exit(exit_code)

def codesigntree(map_file,
        root_dir,
        ent_dir,
        overrides,
        simulate,
        verbose,
        log,
        cs_path="/usr/bin/codesign"):

    """Codesign a tree of files

    Given a map file and a directory tree rooted at the provided root
    dir, run the codesign command on the files specified.

    Returns False if an error was encountered, otherwise True.

    Parameters:
    map_file (string) -- path to the the JSON map file as documented
                         above
    root_dir (string) -- path to the root directory
    ent_dir (string)  -- path to the directory containing any
                         entitlement files used in the map file
    overrides (dict)  -- override map file settings for all codesign
                         invocations:
                             overrides["force"] (bool)
                             overrides["runtime"] (bool)
                             overrides["sign"] (string)
                             overrides["requirements"] (string)
                             overrides["keychain"] (string)
                             overrides["entitlements"] (string)
    simulate (bool)   -- a flag indicating the codesign command should
                         not be run
    verbose (bool)    -- a flag for printing extra information
    log (logger)      -- a logger to use for logging errors, warnings
    cs_path (string)  -- path to the codesign command
                         (default "/usr/bin/codesign")
    """

    MIN_PYTHON = (3, 5) # due to the use of glob recursive option
    if sys.version_info < MIN_PYTHON:
        log.error("ERROR: Python %s.%s or later is required." % MIN_PYTHON)
        return False

    ent_dir = ent_dir.rstrip("/")
    root_dir = root_dir.rstrip("/")

    log.debug("json map file: %s" % map_file);
    log.debug("entitlement directory: %s" % ent_dir);
    log.debug("root directory: %s" % root_dir);
    log.debug("codesign command to use: %s" % cs_path);

    # Make sure only allowed override params have been passed
    for override in sorted(overrides.keys()):
        if override not in ALLOWED_OVERRIDE_KEYS:
            log.error("ERROR: Invalid override key: %s" % override)
            return False
        log.debug("override: %s: %s" % (override, overrides[override]))

    cs_map_string = open(map_file).read()
    cs_map = json.loads(cs_map_string)

    # Walk the map and make sure all referenced entitlement files are
    # present and readable. Log a warning if filename glob patterns
    # don't match any files.
    for cs_entry in cs_map["map"]:

        # Make sure all map entries have all the required keys
        for key in REQUIRED_MAP_FILE_KEYS:
            if key not in cs_entry:
                log.error("ERROR: \"%s\" key missing from map entry" % key);
                return False

        # It's invalid for a map file entry to have >1 entitlement
        if len(cs_entry["entitlements"]) > 1:
            log.error("ERROR: more than one entitlement file " +
                    "specified for a single codesign map entry")
            return False

        ent_filename = None
        if "entitlements" in overrides:
            ent_filename = overrides["entitlements"]
        elif len(cs_entry["entitlements"]) == 1:
            ent_filename = cs_entry["entitlements"][0]
        if ent_filename is not None:
            ent_fullpath = ent_dir + "/" + ent_filename;
            if (not os.path.exists(ent_fullpath) or
                    not os.access(ent_fullpath, os.R_OK)):
                log.error("ERROR: entitlement file \"%s\" could not be read" %
                        ent_fullpath)
                return False

        for path_glob in cs_entry["globs"]:
            if not path_glob.startswith("/"):
                log.error("ERROR: file pattern \"%s\" must start with \"/\""
                        % path_glob)
                return False
            binary_paths = glob.glob(root_dir + path_glob, recursive=True)
            if len(binary_paths) == 0:
                log.warning("file pattern \"%s\" matches no files" % path_glob)

        if len(cs_entry["sign"]) == 0 and "sign" not in overrides:
            log.error("ERROR: map file missing \"sign\" entry and no signing " +
                    "override provided")
            return False

    # walk the map and run codesign for each entry
    for cs_entry in cs_map["map"]:

        # replace entries in cs_entry with their overrides
        for override in overrides:
            cs_entry[override] = overrides[override]

        # build the codesign command in |cs_cmd|
        cs_cmd = [cs_path, "-v"]

        if "deep" in cs_entry and cs_entry["deep"] is True:
            cs_cmd.append("--deep")

        if "force" in cs_entry and cs_entry["force"] is True:
            cs_cmd.append("--force")

        for string_option in ["sign", "requirements", "keychain"]:
            if string_option in cs_entry and len(cs_entry[string_option]) > 0:
                cs_cmd.append("--%s" % string_option)
                cs_cmd.append(cs_entry[string_option])

        if "runtime" in cs_entry and cs_entry["runtime"] is True:
            cs_cmd.append("--options")
            cs_cmd.append("runtime")

        if len(cs_entry["entitlements"]) > 0:
            ent_fullpath = ent_dir + "/" + cs_entry["entitlements"][0]
            cs_cmd.append("--entitlements")
            cs_cmd.append(ent_fullpath)

        for path_glob in cs_entry["globs"]:
            path_glob = root_dir + path_glob
            binary_paths = glob.glob(path_glob, recursive=True)
            for binary_path in binary_paths:
                cs_cmd.append(binary_path)

        if verbose or simulate:
            log.info(" ".join(cs_cmd))

        if not simulate:
            subprocess.run(cs_cmd)

    return True

if __name__ == '__main__':
    main()
