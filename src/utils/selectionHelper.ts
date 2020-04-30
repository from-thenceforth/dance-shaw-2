import * as vscode from 'vscode'

import { CommandState } from '../commands'
import { EditorState }       from '../state/editor'
import { SelectionBehavior } from '../state/extension'

/**
 * Direction of an operation.
 */
export const enum Direction {
  /** Forward direction (`1`). */
  Forward = 1,
  /** Backward direction (`-1`). */
  Backward = -1,
}

/**
 * Whether or not an operation should expend a selection.
 */
export type ExtendBehavior = boolean

/** Forward direction. */
export const Forward = Direction.Forward
/** Backward direction. */
export const Backward = Direction.Backward

/** Do extend. */
export const Extend = true as ExtendBehavior
/** Do not extend. */
export const DoNotExtend = false as ExtendBehavior

export class SelectionHelper {
  static for(editorState: EditorState, state: CommandState): SelectionHelper {
    // TODO: Caching
    return new SelectionHelper(editorState, state)
  }

  readonly selectionBehavior = this.state.selectionBehavior

  /**
   * Get the "cursor active" Coord of a selection.
   *
   * In other words, the basis Coord for moving, etc. of the selection. This
   * method handles special cases for non-directional selections correctly.
   * @param selection
   */
  activeCoord(selection: vscode.Selection): Coord {
    if (this.selectionBehavior === SelectionBehavior.Caret) return selection.active
    if (selection.isEmpty) return selection.active
    if (selection.isReversed) {
      return selection.active
    } else {
      return this.coordAt(this.offsetAt(selection.active) - 1)
    }
  }

  /**
   * Apply a transformation to each selection.
   *
   * @param mapper a function takes the old selection and return a new one or
   *               null if the selection should be deleted
   *
   * @see moveActiveCoord,jumpTo for creating mappers for common operations
  */
  mapEach(mapper: SelectionMapper): void {
    const newSelections: vscode.Selection[] = []
    const editor = this.editor
    let acceptOverflow = true
    const len = editor.selections.length
    for (let i = 0; i < len; i++) {
      const moveResult = mapper(editor.selections[i], this, i)
      if (moveResult === null) {
        if (acceptOverflow)
          newSelections.push(editor.selections[i])
      } else {
        if (acceptOverflow) {
          newSelections.length = 0 // Clear all overflow selections so far.
          acceptOverflow = false
        }
        newSelections.push(moveResult)
      }
    }
    if (acceptOverflow)
      console.warn('No selections remaining.')
    editor.selections = newSelections
  }


  /** Deprecated, will be refactored out soon */
  moveEach(moveFunc: MoveFunc, extend: ExtendBehavior): void {
    const newSelections: vscode.Selection[] = []
    const editor = this.editor
    let acceptOverflow = true
    for (let i = 0; i < editor.selections.length; i++) {
      const startAt = this.activeCoord(editor.selections[i])
      console.log('START=', this._visualizeCoord(startAt))
      const moveResult = moveFunc(startAt, this, i)
      if (typeof moveResult.maybeAnchor === 'object')
        console.log('ANCHOR?', this._visualizeCoord(moveResult.maybeAnchor))
      if (typeof moveResult.active === 'object')
        console.log('ACTIVE=', this._visualizeCoord(moveResult.active))
      if (acceptOverflow && !moveResult.overflow) {
        newSelections.length = 0 // Clear all overflow selections so far.
        acceptOverflow = false
      }
      if (!moveResult.overflow || acceptOverflow) {
        newSelections.push(this.evolve(extend, editor.selections[i], moveResult))
      }
    }
    if (acceptOverflow)
      console.warn('No selections remaining.')
    editor.selections = newSelections
  }

  /** Deprecated, will be refactored out soon */
  evolve(extend: boolean, oldSelection: vscode.Selection, moveResult: MoveResult) {
    if (!moveResult.maybeAnchor) {
      if (typeof moveResult.active === 'object')
        return this.extend(oldSelection, moveResult.active)
      else
        return oldSelection
    }
    let active = moveResult.active!
    if (active === AtOrBefore) {
      if (moveResult.maybeAnchor === OldActive)
        throw new Error('{anchor: OldActive, active: AtOrBefore} is unsupported')
      if (this.selectionBehavior === SelectionBehavior.Caret)
        return new vscode.Selection(extend ? oldSelection.anchor : moveResult.maybeAnchor, moveResult.maybeAnchor)
      active = moveResult.maybeAnchor
    }
    if (extend)
      return this.extend(oldSelection, active)

    const oldActiveCoord = this.activeCoord(oldSelection)
    let anchor = moveResult.maybeAnchor
    if (anchor === OldActive) {
      if (this.selectionBehavior === SelectionBehavior.Caret) {
        let activePos = oldSelection.active.isBeforeOrEqual(active) ?
          this.coordAt(this.offsetAt(active) + 1) : active
        return new vscode.Selection(oldSelection.active, activePos)
      }
      anchor = oldActiveCoord
    }
    return this.selectionBetween(anchor, active, oldActiveCoord)
  }

  /**
   * Return a selection that spans from and to (both inclusive).
   * @param from the coordinate of the starting symbol to include
   * @param to the coordinate of the ending symbol to include
   * @param ref reference coord for where the previous active symbol is at, used
   *            to decide the direction of one-character selections, if enabled.
   */
  selectionBetween(from: Coord, to: Coord, ref: Coord): vscode.Selection {
    // TODO: Remove this.coordAt and this.offsetAt. Use lineAt for shifting to
    // the next position.
    if (from.isBefore(to) ||
        (from.isEqual(to) && (this.selectionBehavior === SelectionBehavior.Character || to.isAfter(ref)))) {
      // Forward: 0123456 ==select(1, 4)=> 0<1234|56
      // Need to increment `to` to include the last character.
      const active = this.coordAt(this.offsetAt(to) + 1)
      return new vscode.Selection(from, active)
    } else {
      // Reverse: 0123456 ==select(4, 1)=> 0|1234>56
      // Need to increment `from` to include the last character.
      const anchor = this.coordAt(this.offsetAt(from) + 1)
      return new vscode.Selection(anchor, to)
    }
  }

  extend(oldSelection: vscode.Selection, to: Coord): vscode.Selection {
    // TODO: Remove this.coordAt and this.offsetAt. Use lineAt for shifting to
    // the next / previous position.
    let { anchor } = oldSelection
    if (anchor.isBeforeOrEqual(to)) {
      // The resulting selection will be forward-facing.
      if (this.selectionBehavior === SelectionBehavior.Character && oldSelection.isReversed) {
        // Flipping selections in the opposite direction: 0|1>2345 to 0<12345|
        // Need to push anchor backwards so that the first symbol is included.
        anchor = this.coordAt(this.offsetAt(anchor) - 1)
      }
      if (this.selectionBehavior === SelectionBehavior.Character || to.isAfterOrEqual(oldSelection.active)) {
        // Moving forward (or non-directional): 01|23>456 ==(to 4)==> 01|234>56
        // Need to increment to include the the symbol at `to`.
        const active = this.coordAt(this.offsetAt(to) + 1)
        return new vscode.Selection(anchor, active)
      } else {
        // Moving backwards: 01|23>456 ==(to 2)==> 01|>23456
        // The symbol at `to` is excluded in this case, since we're
        // "deselecting" that character.
        return new vscode.Selection(anchor, to)
      }
    } else {
      // The resulting selection will be (most likely) backwards-facing.
      const afterTo = this.coordAt(this.offsetAt(to) + 1)
      if (this.selectionBehavior === SelectionBehavior.Character) {
        if ((!oldSelection.isReversed && oldSelection.anchor.isEqual(to)) ||
            (oldSelection.isReversed && oldSelection.anchor.isEqual(afterTo))) {
          // Special case one character selections to face forward:
          return new vscode.Selection(to, afterTo)
        } else if (!oldSelection.isReversed) {
          // Flipping selections in the opposite direction: 0123<4|5 to |01234>5
          // Need to push anchor forward so that the last symbol is included.
          anchor = this.coordAt(this.offsetAt(anchor) + 1)
        }
      }
      if (this.selectionBehavior === SelectionBehavior.Character || to.isBeforeOrEqual(oldSelection.active)) {
        // Moving backward (or non-directional): 012<34|5 ==(to 2)==> 01<234|5
        // Include the symbol at `to`.
        return new vscode.Selection(anchor, to)
      } else {
        // Moving forward (or non-directional): 012<34|5 ==(to 4)==> 01234<|5
        // The symbol at `to` is excluded in this case, since we're
        // "deselecting" that character.
        return new vscode.Selection(anchor, afterTo)
      }
    }
  }

  /**
   * Get the line and character of an offset in the document.
   *
   * This should be used instead of `this.coordAt` to make
   * the intention clear and also allow future optimization like caching.
   * @param coordOffset the nth symbol (or line break) in the document
   */
  coordAt(coordOffset: number): Coord {
    // TODO: Caching
    return this.editor.document.positionAt(coordOffset)
  }

  /**
   * Get the total sequence number of symbol (or line break) in the document.
   *
   * This should be used instead of `this.offsetAt` to make
   * the intention clear and also allow future optimization like caching.
   * @param coord the line and character of the symbol in the document
   */
  offsetAt(coord: Coord): CoordOffset {
    // TODO: Caching
    return this.editor.document.offsetAt(coord)
  }

  endLine(selection: vscode.Selection) {
    if (this.selectionBehavior === SelectionBehavior.Character && selection.end === selection.active && selection.end.character === 0)
      return selection.end.line - 1
    else
      return selection.end.line
  }

  /**
   * The selection length of the given selection, as defined by `offsetAt(active) - offsetAt(anchor)`.
   *
   * If the selection is reversed, the selection length is negative.
   */
  selectionLength(selection: vscode.Selection) {
    if (selection.isSingleLine)
      return selection.active.character - selection.anchor.character

    return this.offsetAt(selection.active) - this.offsetAt(selection.anchor)
  }

  selectionFromLength(anchorCoord: Coord, length: number) {
    return new vscode.Selection(anchorCoord, this.coordAt(this.offsetAt(anchorCoord) + length))
  }

  /** DEBUG ONLY method to visualize an offset. DO NOT leave calls in code. */
  _visualizeOffset(offset: number): string {
    const position = this.coordAt(offset)
    return this._visualizePosition(position)
  }

  /** DEBUG ONLY method to visualize a position. DO NOT leave calls in code. */
  _visualizePosition(position: vscode.Position): string {
    const text = this.editor.document.lineAt(position.line).text
    return position.line + ':  ' + text.substr(0, position.character) + '|' + text.substr(position.character)
  }

  /** DEBUG ONLY method to visualize a Coord. DO NOT leave calls in code. */
  _visualizeCoord(coord: Coord): string {
    const text = this.editor.document.lineAt(coord.line).text
    let visualLine
    if (coord.character === text.length) {
      visualLine = text + '⏎'
    } else {
      visualLine = text.substr(0, coord.character) + `[${text[coord.character]}]` + text.substr(coord.character + 1)
    }
    return `L${coord.line}:  ${visualLine}`
  }

  readonly editor: vscode.TextEditor

  private constructor(public readonly editorState: EditorState, public readonly state: CommandState) {
    this.editor = editorState.editor
  }
}

/**
 * A coordinate (line, character) in the document. It stands for the c-th
 * text symbol at the l-th line in the document (both zero-indexed).
 *
 * Note that a Coord should always be interpreted to be pointed at a text symbol
 * or the line break at the end of the current line (e.g. the 'b' in 'abc').
 * It should not be mistaken for a Position between symbols (a|bc in 'abc').
 */
export interface Coord extends vscode.Position {
  // Dummy interface so that it shows as its type in generated docs, IDE hover
  // tooltips, etc. Do not add fields here.
}
export const Coord = vscode.Position // To allow sugar like `new Coord(1, 2)`.
export type CoordOffset = number

export type SelectionMapper = (selection: vscode.Selection, helper: SelectionHelper, i: number) => vscode.Selection | null
export type CoordMapper = (oldActive: Coord, helper: SelectionHelper, i: number) => Coord | null

// BEGIN DEPRECATED
export type MoveFunc = (from: Coord, helper: SelectionHelper, i: number) => MoveResult;

export const OldActive = 'oldActive'
export const AtOrBefore = 'atOrBefore'
export type MoveResult = {overflow?: false, maybeAnchor: Coord | typeof OldActive, active: Coord | typeof AtOrBefore} |
                         {overflow: true,   maybeAnchor: Coord | undefined,        active: Coord | undefined}
// END DEPRECATED

/**
 * Create a SelectionMapper that moves selection's active to a new coordinate.
 *
 * @summary The mapper created is useful for commands that "drags" to a
 * character such as `f` (selectTo) without moving anchor.
 *
 * When extending, the new selection will keep the same anchor caret /
 * character (depending on `this.selectionBehavior`). When not extending, the
 * new selection anchors to the old active caret / character. Either way,
 * the new active will always sweep over the symbol at the coordinate
 * returned, selecting or deselecting it as appropriate.
 *
 * @param activeMapper a function that takes an old active coordinate and return
 *                     the coordinate of the new symbol to move to or `null` if
 *                     it would move out of bound
 * @param extend if Extend, the new selection will keep the anchor caret /
 *               character. Otherwise, it is anchored to old active.
 * @returns a SelectionMapper that is suitable for SelectionHelper#mapEach
 */
export function moveActiveCoord(activeMapper: CoordMapper, extend: ExtendBehavior): SelectionMapper {
  return (selection, helper, i) => {
    const oldActive = helper.activeCoord(selection)
    const newActive = activeMapper(oldActive, helper, i)
    if (newActive === null) return null

    if (extend)
      return helper.extend(selection, newActive)

    if (helper.selectionBehavior === SelectionBehavior.Caret) {
      // TODO: Optimize to avoid coordAt / offsetAt.
      let activePos = selection.active.isBeforeOrEqual(newActive) ?
        helper.coordAt(helper.offsetAt(newActive) + 1) : newActive
      return new vscode.Selection(selection.active, activePos)
    }

    const ref = oldActive
    return helper.selectionBetween(oldActive, newActive, ref)
  }
}

/**
 * Create a SelectionMapper that jump / extend the selection to a new position
 * (caret or coordinate, depending on `this.selectionBehavior`).
 *
 * @summary The mapper created is useful for commands that "jump" to a place
 * without dragging to it, such as `gg` (gotoFirstLine) or arrows (`hjkl`).
 *
 * When `this.selectionBehavior` is Caret, the new active will be at the caret
 * at the result Position. When not extending, the anchor is moved there as
 * well, creating an empty selection on that spot.
 *
 * When `this.selectionBehavior` is Character and extending, new active always
 * include the symbol at Position. When not extending, the new selection will
 * contain exactly one symbol under the result Position.
 *
 * @param activeMapper a function that takes an old active coordinate and return
 *                     the caret / character move to or `null` if it would move
 *                     out of bound
 * @param extend if Extend, the new selection will keep the anchor caret /
 *               character. Otherwise, it is anchored to old active.
 * @returns a SelectionMapper that is suitable for SelectionHelper#mapEach
 */
export function jumpTo(activeMapper: CoordMapper, extend: ExtendBehavior): SelectionMapper {
  return (selection, helper, i) => {
    const oldActive = helper.activeCoord(selection)
    const newActive = activeMapper(oldActive, helper, i)
    if (newActive === null) return null

    if (helper.selectionBehavior === SelectionBehavior.Caret)
      return new vscode.Selection(extend ? selection.anchor : newActive, newActive)

    if (extend)
      return helper.extend(selection, newActive)

    const ref = newActive
    return helper.selectionBetween(newActive, newActive, ref)
  }
}
