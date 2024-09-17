# Copyright (c) the JPEG XL Project Authors. All rights reserved.
#
# Use of this source code is governed by a BSD-style
# license that can be found in the LICENSE file.

find_package(PkgConfig QUIET)
if (PkgConfig_FOUND)
  pkg_check_modules(PC_HWY QUIET libhwy)
  set(HWY_VERSION ${PC_HWY_VERSION})
endif ()

find_path(HWY_INCLUDE_DIR
  NAMES hwy/base.h hwy/highway.h
  HINTS ${PC_HWY_INCLUDEDIR} ${PC_HWY_INCLUDE_DIRS}
)

find_library(HWY_LIBRARY
  NAMES ${HWY_NAMES} hwy
  HINTS ${PC_HWY_LIBDIR} ${PC_HWY_LIBRARY_DIRS}
)

# If version not found using pkg-config, try extracting it from header files
if (HWY_INCLUDE_DIR AND NOT HWY_VERSION)
  set(HWY_VERSION "")
  set(HWY_POSSIBLE_HEADERS "${HWY_INCLUDE_DIR}/hwy/base.h" "${HWY_INCLUDE_DIR}/hwy/highway.h")
  foreach(HWY_HEADER_FILE IN LISTS HWY_POSSIBLE_HEADERS)
    if (EXISTS "${HWY_HEADER_FILE}")
      file(READ  "${HWY_HEADER_FILE}" HWY_VERSION_CONTENT)

      string(REGEX MATCH "#define HWY_MAJOR +([0-9]+)" _sink "${HWY_VERSION_CONTENT}")
      set(HWY_VERSION_MAJOR "${CMAKE_MATCH_1}")

      string(REGEX MATCH "#define +HWY_MINOR +([0-9]+)" _sink "${HWY_VERSION_CONTENT}")
      set(HWY_VERSION_MINOR "${CMAKE_MATCH_1}")

      string(REGEX MATCH "#define +HWY_PATCH +([0-9]+)" _sink "${HWY_VERSION_CONTENT}")
      set(HWY_VERSION_PATCH "${CMAKE_MATCH_1}")
      if (NOT HWY_VERSION_MAJOR STREQUAL "" AND NOT HWY_VERSION_MINOR STREQUAL "" AND NOT HWY_VERSION_PATCH STREQUAL "")
        set(HWY_VERSION "${HWY_VERSION_MAJOR}.${HWY_VERSION_MINOR}.${HWY_VERSION_PATCH}")
        break()
      endif()
    endif ()
  endforeach ()
  if (NOT HWY_VERSION)
    message(WARNING "Highway version not found.")
  endif()
endif ()

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(HWY
  FOUND_VAR HWY_FOUND
  REQUIRED_VARS HWY_LIBRARY HWY_INCLUDE_DIR
  VERSION_VAR HWY_VERSION
)

if (HWY_LIBRARY AND NOT TARGET hwy)
  add_library(hwy INTERFACE IMPORTED GLOBAL)

  if(CMAKE_VERSION VERSION_LESS "3.13.5")
    set_property(TARGET hwy PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${HWY_INCLUDE_DIR})
    target_link_libraries(hwy INTERFACE ${HWY_LIBRARY})
    set_property(TARGET hwy PROPERTY INTERFACE_COMPILE_OPTIONS ${PC_HWY_CFLAGS_OTHER})
  else()
    target_include_directories(hwy INTERFACE ${HWY_INCLUDE_DIR})
    target_link_libraries(hwy INTERFACE ${HWY_LIBRARY})
    target_link_options(hwy INTERFACE ${PC_HWY_LDFLAGS_OTHER})
    target_compile_options(hwy INTERFACE ${PC_HWY_CFLAGS_OTHER})
  endif()
endif()

mark_as_advanced(HWY_INCLUDE_DIR HWY_LIBRARY)

if (HWY_FOUND)
    set(HWY_LIBRARIES ${HWY_LIBRARY})
    set(HWY_INCLUDE_DIRS ${HWY_INCLUDE_DIR})
endif ()
