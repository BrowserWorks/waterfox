/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EnterprisePolicies.h"

#include <filesystem>
#include <format>
#include <fstream>
#include <string_view>
#include <string>
#include <windows.h>

#include <json/json.h>

namespace fs = std::filesystem;

namespace {

static fs::path GetDistributionPoliciesFilePath(const fs::path& aDir) noexcept {
  const fs::path kRelativeFilePath{"distribution/policies.json"};
  return aDir / kRelativeFilePath;
}

static bool EnterprisePoliciesInRegistry(HKEY aHive, std::wstring_view aBrand) {
  std::wstring keyPath{
      std::format(LR"(SOFTWARE\Policies\BrowserWorks\{})", aBrand)};

  HKEY key{};
  if (RegOpenKeyExW(aHive, keyPath.c_str(), 0, KEY_READ, &key) !=
      ERROR_SUCCESS) {
    return false;
  }

  DWORD numSubkeys{0};
  DWORD numValues{0};
  LONG rv{RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, &numSubkeys, nullptr,
                           nullptr, &numValues, nullptr, nullptr, nullptr,
                           nullptr)};
  if (rv != ERROR_SUCCESS) {
    RegCloseKey(key);
    return false;
  }

  // If there is any value, it's enterprise managed
  if (numValues > 0) {
    RegCloseKey(key);
    return true;
  }

  // If there are no subkeys, it's not enterprise managed
  if (numSubkeys == 0) {
    RegCloseKey(key);
    return false;
  }

  // If there's more than one subkey, it's enterprise managed
  if (numSubkeys > 1) {
    RegCloseKey(key);
    return true;
  }

  // If the only subkey isn't Certificates, it's enterprise managed
  wchar_t subkeyName[MAX_PATH + 1]{};
  DWORD subkeyNameLen{MAX_PATH + 1};
  rv = RegEnumKeyExW(key, 0, subkeyName, &subkeyNameLen, nullptr, nullptr,
                     nullptr, nullptr);
  RegCloseKey(key);
  if (rv != ERROR_SUCCESS || _wcsicmp(subkeyName, L"Certificates") != 0) {
    return true;
  }

  std::wstring certsPath{std::format(L"{}\\Certificates", keyPath)};

  HKEY certsKey{};
  if (RegOpenKeyExW(aHive, certsPath.c_str(), 0, KEY_READ, &certsKey) !=
      ERROR_SUCCESS) {
    return true;
  }

  DWORD certsNumSubkeys{0};
  DWORD certsNumValues{0};
  rv = RegQueryInfoKeyW(certsKey, nullptr, nullptr, nullptr, &certsNumSubkeys,
                        nullptr, nullptr, &certsNumValues, nullptr, nullptr,
                        nullptr, nullptr);
  if (rv != ERROR_SUCCESS) {
    RegCloseKey(certsKey);
    return true;
  }

  // If Certificates has additional values, it's enterprise managed
  if (certsNumValues > 1) {
    RegCloseKey(certsKey);
    return true;
  }

  // If Certificates has subkeys, it's enterprise managed
  if (certsNumSubkeys > 0) {
    RegCloseKey(certsKey);
    return true;
  }

  // Read ImportEnterpriseRoots, try as DWORD first, then as string
  bool importEnterpriseRootsEnabled{false};
  DWORD type{};
  DWORD dwordValue{};
  DWORD dataSize{sizeof(dwordValue)};
  rv = RegQueryValueExW(certsKey, L"ImportEnterpriseRoots", nullptr, &type,
                        reinterpret_cast<BYTE*>(&dwordValue), &dataSize);
  if (rv == ERROR_SUCCESS && type == REG_DWORD) {
    importEnterpriseRootsEnabled = (dwordValue == 1);
  } else {
    wchar_t strValue[64]{};
    dataSize = sizeof(strValue);
    rv = RegQueryValueExW(certsKey, L"ImportEnterpriseRoots", nullptr, &type,
                          reinterpret_cast<BYTE*>(strValue), &dataSize);
    if (rv == ERROR_SUCCESS && (type == REG_SZ || type == REG_EXPAND_SZ)) {
      importEnterpriseRootsEnabled =
          _wcsicmp(strValue, L"1") == 0 || _wcsicmp(strValue, L"true") == 0;
    }
  }
  RegCloseKey(certsKey);

  return !importEnterpriseRootsEnabled;
}

}  // namespace

namespace EnterprisePolicies {

bool InDistribution(const std::filesystem::path& aDir) {
  Json::CharReaderBuilder builder;
  std::ifstream file(GetDistributionPoliciesFilePath(aDir));
  Json::Value root;
  std::string errors;
  if (!Json::parseFromStream(builder, file, &root, &errors)) {
    return false;
  }

  if (!root.isObject() || !root.isMember("policies")) {
    return false;
  }

  const Json::Value& policies = root["policies"];
  return !(!policies.isObject() || policies.empty());
}

bool InRegistry(std::wstring_view aBrand) {
  return EnterprisePoliciesInRegistry(HKEY_LOCAL_MACHINE, aBrand) ||
         EnterprisePoliciesInRegistry(HKEY_CURRENT_USER, aBrand);
}

}  // namespace EnterprisePolicies
