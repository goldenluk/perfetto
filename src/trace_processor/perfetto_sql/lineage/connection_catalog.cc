/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "src/trace_processor/perfetto_sql/lineage/connection_catalog.h"

#include <sqlite3.h>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "perfetto/ext/base/string_utils.h"
#include "src/perfetto_sql/analysis/relation.h"
#include "src/trace_processor/core/dataframe/dataframe.h"
#include "src/trace_processor/perfetto_sql/engine/perfetto_sql_connection.h"
#include "src/trace_processor/sqlite/sql_source.h"

namespace perfetto::trace_processor::lineage {
namespace {

std::string Quoted(std::string_view name) {
  std::string out = "'";
  for (char c : name) {
    if (c == '\'') {
      out.push_back('\'');
    }
    out.push_back(c);
  }
  out.push_back('\'');
  return out;
}

}  // namespace

ConnectionCatalog::ConnectionCatalog(PerfettoSqlConnection* connection)
    : connection_(connection) {}

std::optional<analysis::LeafRelation> ConnectionCatalog::FindLeafRelation(
    std::string_view name) const {
  const dataframe::Dataframe* dataframe =
      connection_->GetDataframeOrNull(std::string(name));
  if (!dataframe) {
    return std::nullopt;
  }
  analysis::LeafRelation relation;
  relation.name = name;
  relation.columns.reserve(dataframe->column_names().size());
  for (const std::string& column : dataframe->column_names()) {
    relation.columns.push_back(column);
  }
  return relation;
}

std::optional<std::string> ConnectionCatalog::FindViewSql(
    std::string_view name) const {
  std::string quoted = Quoted(name);
  auto res = connection_->ExecuteUntilLastStatement(
      SqlSource::FromTraceProcessorImplementation(
          "SELECT sql FROM ("
          "SELECT sql, 0 AS priority FROM sqlite_temp_master "
          "WHERE type = 'view' AND name = " +
          quoted +
          " UNION ALL "
          "SELECT sql, 1 AS priority FROM sqlite_master "
          "WHERE type = 'view' AND name = " +
          quoted + ") ORDER BY priority LIMIT 1"));
  if (!res.ok() || res->stmt.IsDone()) {
    return std::nullopt;
  }
  sqlite3_stmt* stmt = res->stmt.sqlite_stmt();
  const auto* sql = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
  return sql ? std::make_optional(std::string(sql)) : std::nullopt;
}

std::optional<core::StorageType> ConnectionCatalog::ColumnType(
    const analysis::ColumnLineage& column) const {
  std::optional<core::StorageType> result;
  for (const analysis::ColumnOrigin& origin : column.origins) {
    const dataframe::Dataframe* dataframe =
        connection_->GetDataframeOrNull(std::string(origin.relation_name));
    if (!dataframe) {
      return std::nullopt;
    }
    std::string column_name(origin.column_name);
    const std::vector<std::string>& names = dataframe->column_names();
    auto found =
        std::find_if(names.begin(), names.end(), [&](const auto& name) {
          return base::CaseInsensitiveEqual(name, column_name);
        });
    if (found == names.end()) {
      return std::nullopt;
    }
    core::StorageType type =
        dataframe->column_type(static_cast<uint32_t>(found - names.begin()));
    if (result && !(*result == type)) {
      return std::nullopt;
    }
    result = type;
  }
  return result;
}

}  // namespace perfetto::trace_processor::lineage
