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

#include "src/trace_processor/core/exec/assert_type.h"

#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

#include "perfetto/base/status.h"
#include "src/trace_processor/containers/string_pool.h"
#include "src/trace_processor/core/common/storage_types.h"
#include "src/trace_processor/core/exec/column_view.h"
#include "src/trace_processor/core/exec/operator.h"
#include "src/trace_processor/core/exec/row_batch.h"
#include "src/trace_processor/core/exec/row_selection.h"
#include "src/trace_processor/core/exec/variant.h"
#include "src/trace_processor/core/util/flex_vector.h"

namespace perfetto::trace_processor::core::exec {
namespace {

const char* Name(Variant::Type type) {
  switch (type) {
    case Variant::Type::kNull:
      return "a null";
    case Variant::Type::kInt64:
      return "an integer";
    case Variant::Type::kDouble:
      return "a float";
    case Variant::Type::kString:
      return "a string";
  }
  return "something";
}

const char* Name(StorageType type) {
  if (type.Is<Id>() || type.Is<Uint32>() || type.Is<Int32>() ||
      type.Is<Int64>()) {
    return "an integer";
  }
  return type.Is<Double>() ? "a float" : "a string";
}

// `resolve` is a template parameter so the loop carries no per-row branch on
// how a row is reached.
template <typename Resolve, typename Write>
bool Walk(Resolve resolve, uint32_t count, Write write) {
  for (uint32_t i = 0; i < count; ++i) {
    if (!write(i, resolve(i))) {
      return false;
    }
  }
  return true;
}

template <typename From, typename To>
void WidenAs(const ColumnView& column,
             uint32_t count,
             FlexVector<To>& out,
             BitVector& out_validity) {
  const BitVector* validity = column.validity();
  out_validity.ClearAllBits();
  for (uint32_t row = 0; row < count; ++row) {
    uint32_t index = column.selection().GetIndex(row);
    if (validity && !validity->is_set(index)) {
      out[row] = To{};
      continue;
    }
    out[row] = static_cast<To>(column.Value<From>(row));
    out_validity.set(row);
  }
}

bool ExactDouble(int64_t value, double* out) {
  constexpr double kInt64Limit = 0x1p63;
  double widened = static_cast<double>(value);
  if (widened >= kInt64Limit || widened < -kInt64Limit ||
      static_cast<int64_t>(widened) != value) {
    return false;
  }
  *out = widened;
  return true;
}

}  // namespace

AssertType::AssertType(uint32_t column, AssertTypeTarget type, std::string name)
    : column_(column),
      type_(type.Upcast<StorageType>()),
      name_(std::move(name)) {}

AssertType::~AssertType() = default;

bool AssertType::Widen(const ColumnView& column,
                       uint32_t count,
                       State& state) const {
  Values& values = *state.values;
  if (type_.Is<Int64>()) {
    if (column.type().Is<Id>() || column.type().Is<Uint32>()) {
      WidenAs<uint32_t>(column, count, values.ints, values.validity);
    } else {
      WidenAs<int32_t>(column, count, values.ints, values.validity);
    }
    return true;
  }
  if (column.type().Is<Id>() || column.type().Is<Uint32>()) {
    WidenAs<uint32_t>(column, count, values.doubles, values.validity);
    return true;
  }
  if (column.type().Is<Int32>()) {
    WidenAs<int32_t>(column, count, values.doubles, values.validity);
    return true;
  }

  const BitVector* validity = column.validity();
  values.validity.ClearAllBits();
  for (uint32_t row = 0; row < count; ++row) {
    uint32_t index = column.selection().GetIndex(row);
    if (validity && !validity->is_set(index)) {
      values.doubles[row] = 0;
      continue;
    }
    if (!ExactDouble(column.Value<int64_t>(row), &values.doubles[row])) {
      state.status = base::ErrStatus(
          "column '%s' holds an integer too large to be a float",
          name_.c_str());
      return false;
    }
    values.validity.set(row);
  }
  return true;
}
AssertType::State::~State() = default;

std::unique_ptr<OperatorState> AssertType::MakeState() const {
  auto state = std::make_unique<State>();
  if (type_.Is<Int64>()) {
    state->values->ints.resize(kMaxBatchRows);
  } else if (type_.Is<Double>()) {
    state->values->doubles.resize(kMaxBatchRows);
  } else {
    state->values->strings.resize(kMaxBatchRows);
  }
  state->values->validity = BitVector::CreateWithSize(kMaxBatchRows);
  return state;
}

base::Status AssertType::status(const OperatorState& state) const {
  return state.Cast<const State>().status;
}

void AssertType::Rewind(OperatorState& state) const {
  state.Cast<State>().status = base::OkStatus();
}

OpResult AssertType::Execute(const RowBatch& in,
                             RowBatch& out,
                             OperatorState& state) const {
  State& s = state.Cast<State>();
  out.CopyFrom(in);
  const ColumnView& column = in.column(column_);
  if (column.kind() != ColumnView::Kind::kVariant) {
    if (column.type() == type_) {
      return OpResult::kNeedMoreInput;
    }
    bool integer = column.type().Is<Id>() || column.type().Is<Uint32>() ||
                   column.type().Is<Int32>() || column.type().Is<Int64>();
    bool widen = integer && (type_.Is<Double>() ||
                             (type_.Is<Int64>() && !column.type().Is<Int64>()));
    if (widen) {
      if (!Widen(column, in.size(), s)) {
        return OpResult::kError;
      }
      const void* data =
          type_.Is<Int64>()
              ? static_cast<const void*>(s.values->ints.data())
              : static_cast<const void*>(s.values->doubles.data());
      out.SetColumn(column_,
                    ColumnView::Reference(type_, data, &s.values->validity),
                    s.values);
      return OpResult::kNeedMoreInput;
    }
    s.status = base::ErrStatus("column '%s' is %s, not %s", name_.c_str(),
                               Name(column.type()), Name(type_));
    return OpResult::kError;
  }

  uint32_t count = in.size();
  const auto* cells = static_cast<const Variant*>(column.data());
  Values& values = *s.values;
  values.validity.ClearAllBits();
  auto write = [&](uint32_t row, const Variant& cell) {
    if (cell.type == Variant::Type::kNull) {
      // Written even for a null row, so nothing downstream reads an
      // uninitialised slot.
      if (type_.Is<Int64>()) {
        values.ints[row] = 0;
      } else if (type_.Is<Double>()) {
        values.doubles[row] = 0;
      } else {
        values.strings[row] = StringPool::Id::Null();
      }
      return true;
    }
    if (type_.Is<Int64>() && cell.type == Variant::Type::kInt64) {
      values.ints[row] = cell.AsInt64();
    } else if (type_.Is<Double>() && cell.type == Variant::Type::kDouble) {
      values.doubles[row] = cell.AsDouble();
    } else if (type_.Is<Double>() && cell.type == Variant::Type::kInt64) {
      if (!ExactDouble(cell.AsInt64(), &values.doubles[row])) {
        s.status = base::ErrStatus(
            "column '%s' holds an integer too large to be a float",
            name_.c_str());
        return false;
      }
    } else if (type_.Is<String>() && cell.type == Variant::Type::kString) {
      values.strings[row] = cell.AsString();
    } else {
      s.status = base::ErrStatus("column '%s' holds %s, not %s", name_.c_str(),
                                 Name(cell.type), Name(type_));
      return false;
    }
    values.validity.set(row);
    return true;
  };

  RowSelection selection = column.selection();
  bool ok;
  if (selection.is_range()) {
    const Variant* from = cells + selection.offset();
    ok = Walk([from](uint32_t i) -> const Variant& { return from[i]; }, count,
              write);
  } else {
    const uint32_t* rows = selection.data();
    ok = Walk(
        [cells, rows](uint32_t i) -> const Variant& { return cells[rows[i]]; },
        count, write);
  }
  if (!ok) {
    return OpResult::kError;
  }

  const void* data = nullptr;
  if (type_.Is<Int64>()) {
    data = values.ints.data();
  } else if (type_.Is<Double>()) {
    data = values.doubles.data();
  } else {
    data = values.strings.data();
  }
  out.SetColumn(column_, ColumnView::Reference(type_, data, &values.validity),
                s.values);
  return OpResult::kNeedMoreInput;
}

}  // namespace perfetto::trace_processor::core::exec
