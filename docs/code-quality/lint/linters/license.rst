License
=======

This linter verifies if a file has a known license header.

By default, Firefox uses MPL-2 license with the `appropriate headers <https://www.mozilla.org/en-US/MPL/headers/>`_.
In some cases (third-party code), a file might have a different header file.
If this is the case, one of the significant line of the header should be listed in the list :searchfox:`of valid licenses <tools/lint/license/valid-licenses.txt>`.

Run Locally
-----------

This mozlint linter can be run using mach:

.. parsed-literal::

    $ mach lint --linter license <file paths>


Configuration
-------------

This linter is enabled on most of the whole code base.

Autofix
-------

This linter provides a ``--fix`` option that adds the right MPL-2 header at the right place depending on the script or source language.


Sources
-------

* :searchfox:`Configuration (YAML) <tools/lint/license.yml>`
* :searchfox:`Source (Rust) <tools/lint/mozcheck/src/license.rs>`
