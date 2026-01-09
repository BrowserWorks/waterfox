# Copyright (c) the JPEG XL Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

function(target_link_skcms TARGET_NAME)
  set(_sources_dir "${PROJECT_SOURCE_DIR}/third_party/skcms")
  set(_sources
    "${_sources_dir}/skcms.cc"
    "${_sources_dir}/src/skcms_TransformBaseline.cc"
  )

  # TODO(eustas): investigate if we need this.
  set(_common_copts)
  include(CheckCXXCompilerFlag)
  check_cxx_compiler_flag("-Wno-psabi" CXX_WPSABI_SUPPORTED)
  if (CXX_WPSABI_SUPPORTED)
    set(_common_copts "-Wno-psabi")
    set_source_files_properties(${_sources}
      PROPERTIES COMPILE_OPTIONS "${_common_copts}"
      TARGET_DIRECTORY ${TARGET_NAME}
    )
  endif()

  if (CMAKE_CXX_COMPILER_ID MATCHES "GNU")
    set_source_files_properties("${_sources_dir}/src/skcms_TransformBaseline.cc"
      PROPERTIES COMPILE_OPTIONS "${_common_copts};-Wno-maybe-uninitialized"
      TARGET_DIRECTORY ${TARGET_NAME}
    )
  endif()

  set(_use_avx2 FALSE)
  set(_use_avx512 FALSE)
  if (CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64" AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    if (CXX_MAVX2_SUPPORTED AND CXX_MF16C_SUPPORTED)
      set(_use_avx2 TRUE)
    endif()
    if (CXX_MAVX512F_SUPPORTED AND CXX_MAVX512DQ_SUPPORTED AND CXX_MAVX512CD_SUPPORTED AND CXX_MAVX512BW_SUPPORTED AND CXX_MAVX512VL_SUPPORTED)
      set(_use_avx512 TRUE)
    endif()
  endif()

  if (_use_avx2)
    list(APPEND _sources "${_sources_dir}/src/skcms_TransformHsw.cc")
    set_source_files_properties("${_sources_dir}/src/skcms_TransformHsw.cc"
      PROPERTIES COMPILE_OPTIONS "${_common_copts};-march=x86-64;-mavx2;-mf16c"
      TARGET_DIRECTORY ${TARGET_NAME}
    )
  else()
    target_compile_definitions(${TARGET_NAME} PRIVATE -DSKCMS_DISABLE_HSW)
  endif()

  if (_use_avx512)
    list(APPEND _sources "${_sources_dir}/src/skcms_TransformSkx.cc")
    set_source_files_properties("${_sources_dir}/src/skcms_TransformSkx.cc"
      PROPERTIES COMPILE_OPTIONS "${_common_copts};-march=x86-64;-mavx512f;-mavx512dq;-mavx512cd;-mavx512bw;-mavx512vl"
      TARGET_DIRECTORY ${TARGET_NAME}
    )
  else()
    target_compile_definitions(${TARGET_NAME} PRIVATE -DSKCMS_DISABLE_SKX)
  endif()

  if (MINGW)
    target_compile_definitions(${TARGET_NAME} PRIVATE -DSKCMS_HAS_MUSTTAIL=0)
  endif()

  target_sources(${TARGET_NAME} PRIVATE "${_sources}")
  target_include_directories(${TARGET_NAME} PRIVATE "${PROJECT_SOURCE_DIR}/third_party/skcms/")
endfunction()
