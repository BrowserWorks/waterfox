================
Navigation Panel
================

The navigation panel provides various features for the current file.

.. image:: img/navigation-panel.png
    :class: border
    :alt: The navigation panel
    :width: 288px

In the directory listing and some other cases, the navigation panel is collapsed by default.
Clicking the triangle icon at the left end expands/collapses the navigation panel.

.. image:: img/navigation-panel-collapsed.png
    :class: border
    :alt: The navigation panel in a closed state
    :width: 193px

If the window width is less than 1024px, the panel is collapsed by default also in the source listing.
This behavior can be configured in the `settings page <https://searchfox.org/firefox-main/pages/settings.html>`_.

Header
------

The navigation panel provides various features for the current file.

.. image:: img/navigation-panel-header.png
    :class: border
    :alt: The navigation panel header
    :width: 320px

Toggle button
  Expand/collapse the navigation panel.

Help button
  Open this documentation.

Settings button
  Open the `settings page <https://searchfox.org/firefox-main/pages/settings.html>`_.


Enable keyboard shortcuts
  Enable the keyboard shortcuts for the panel items.

Source code
-----------

This section provides feature related to the current file.

Go to header file/Go to source file
  Open the corresponding source or header file.

  This item is shown if the current file is C++ source (``.cpp``, ``.cc``, ``.cxx``) or header file (``.h``, ``.hh``, ``.hpp``, ``.hxx``) and there's corresponding source or header file exists.

File a bug in ...
  Open the Bugzilla new bug page for the associated Bugzilla component.

  This item is shown when the current file/directory has an associated Bugzilla component.

Revision control
----------------

This section provides feature related to the VCS.

Permalink
  Convert the current document's URL into a revision-specific URL.

  This item is shown when opening a revision-agnostic URL.

  For example, if you click the item while you're on ``https://searchfox.org/firefox-main/source/js/src/jsapi.h``, It converts the current URL into ``https://searchfox.org/firefox-main/rev/3f22e78e34249196edab0a5b756394169533b8a1/js/src/jsapi.h`` (the revision ID part depends on the latest revision at that point.)

  The former URL shows the file content of the latest revision at the point of opening the page, and the latter URL shows the file content of the given revision.

  Searchfox index is updated twice a day for the main branches, and this means the file content can change twice a day.  This URL is handy for sharing the code in bug comments or in chat, where people can open the link later.

  This item has associated shortcut key :kbd:`Y`, and hitting the :kbd:`Y` key also does the same.

  Clicking the "Copy to clipboard" button next to this copies the permalink into your clipboard.

  See the :ref:`searchfox-copy-as-markdown` section below for more info about sharing code or reference.

Remove the Permalink
  Convert the current document's URL into a revision agnostic URL.
  This is the opposite operation of the "Permalink" above.

  This item is shown when opening a revision-specific URL, where the revision is the latest revision.

Go to latest version
  Opens the revision-agnostic URL of the current file.

  This item is shown when opning a revision-specific URL, where the revision is not the latest revision.

Git log
  Open the log of the current file on GitHub.

  This item is shown when the current repository is hosted on GitHub.

Mercurial log
  Open the log of the current file on ``hg.mozilla.org``.
  Hitting the :kbd:`L` key also does the same.

  This item is shown when the current repository is hosted on ``hg.mozilla.org``.

Raw
  Open the raw file of the current file.

  This is shown when the repository has a raw file link.

Blame
  This is just a placeholder.
  The blame information is shown in the :ref:`Blame strip <searchfox-blame-strip>`.

Show changeset
  Open the changeset information for the current diff, hosted on Searchfox.

  This item is shown on the annotated diff view.
  (See :ref:`Blame <searchfox-blame>` for the link for the annotated diff view.)


Show file without diff
  Open a revision-specific URL of the current file before the current diff is applied.

  This item is shown on the annotated diff view.
  (See :ref:`Blame <searchfox-blame>` for the link for the annotated diff view.)

Generated file
--------------

Raw
  Open the raw file of the current generated file.
  In contrast to source files, this file is hosted on searchfox itself, and there's no historical data.

Symbol
------

.. image:: img/navigation-panel-symbol.png
    :class: border
    :alt: The navigation panel Symbol section
    :width: 362px

This is behind the alpha feature gate "Fancy Bar".

This section shows the currently-selected symbol's qualified name.

This provides a button to copy the qualified name to clipboard.

.. _searchfox-copy-as-markdown:

Copy as Markdown
----------------

This section provides a feature to copy the selected file/symbol/code as Markdown.
This is handy for sharing the reference in bug comments or in chat.

Filename Link
  Copy the current file's revision-specific URL, with the filename, as Markdown.
  Hitting the :kbd:`F` key also does the same.


  For example, if you're on ``https://searchfox.org/firefox-main/source/js/src/jsapi.h#107``, clicking this copies the following text to clipboard.

  .. code-block::

      [jsapi.h](https://searchfox.org/firefox-main/rev/3f22e78e34249196edab0a5b756394169533b8a1/js/src/jsapi.h#107)

The link includes the currently-selected lines.

Symbol Link
  Copy the current file's revision-specific URL, with the currently-selected symbol, as Markdown.
  Hitting the :kbd:`S` key also does the same.

  For example, if you're on ``https://searchfox.org/firefox-main/source/js/src/jsapi.h#128`` where the line has ``JS::InformalValueTypeName`` function declaration, clicking this copies the following text to clipboard.

  .. code-block::

      [JS::InformalValueTypeName](https://searchfox.org/firefox-main/rev/3f22e78e34249196edab0a5b756394169533b8a1/js/src/jsapi.h#128)

  The link includes the currently-selected lines.

Code Block
  Copy the currently-selected lines as a Markdown code block.
  Hitting the :kbd:`C` key also does the same.

  This is handy for sharing the code in a bug comment, while explaining the execution flow.

  For example, if you're on ``https://searchfox.org/firefox-main/source/js/src/vm/JSObject.cpp#115-119,136-141`` page, where multiple lines are selected, clicking this copies the following text to clipboard.

  .. code-block::

      https://searchfox.org/firefox-main/rev/3f22e78e34249196edab0a5b756394169533b8a1/js/src/vm/JSObject.cpp#115-119,136-141
      ```cpp
      JS_PUBLIC_API const char* JS::InformalValueTypeName(const Value& v) {
        switch (v.type()) {
          case ValueType::Double:
          case ValueType::Int32:
            return "number";
      ...
          case ValueType::PrivateGCThing:
            break;
        }

        MOZ_CRASH("unexpected type");
      }
      ```

Editor
------

.. image:: img/navigation-panel-editor.png
    :class: border
    :alt: The navigation panel Editor section
    :width: 357px

This is behind the alpha feature gate "Fancy Bar", and "Enable Open in Editor widget" flag.

You can enable it in https://searchfox.org/firefox-main/pages/settings.html

This section shows a button to open the current file in your local text editor.
The mapping from the tree name to the local path can be configured in the settings page.

For the files in the tree configured there, this section is shown in the panel.

  Open in Editor
    Open the current file in pre-configured editor

    This item has associated shortcut key :kbd:`\\`, and hitting the :kbd:`\\` key also does the same.


Other Tools
-----------

This section shows links to extension tools.

HG Web
  Open the current file on ``hg.mozilla.org``.

  This item is shown when the current repository is hosted on ``hg.mozilla.org``.

Code Coverage
  Open the code coverage result of this file.

  This item is shown when the current file has code coverage result.

Source Docs
  Open the rendered view of the current file on ``https://firefox-source-docs.mozilla.org/``.

  This item is shown when the current file is a document file (``.md`` or ``.rst``) for Firefox Source Docs.

GitHub Rendered view
  Open the rendered view of the current file on GitHub.

  This item is shown when the current file is a document file.

Debug
-----

This section is behind the "Show debugging UI" setting.

Raw analysis records
  Open a raw analysis file for the current file.

  This item is shown when opening a file.

Show debug log/Hide debug log
  Show/hide the debug log of the current query.

  This item is shown in the query endpoint.

Show results JSON/Hide results JSON
  Show/hide the raw JSON of the current query result.

  This item is shown in the query endpoint.
