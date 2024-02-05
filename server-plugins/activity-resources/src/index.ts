//
// Copyright © 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import activity, { ActivityMessage, DocUpdateMessage, Reaction } from '@hcengineering/activity'
import core, {
  Account,
  AttachedDoc,
  Data,
  Doc,
  MeasureContext,
  Ref,
  Tx,
  TxCUD,
  TxCollectionCUD,
  TxCreateDoc,
  TxProcessor,
  matchQuery
} from '@hcengineering/core'
import { ActivityControl, DocObjectCache } from '@hcengineering/server-activity'
import type { TriggerControl } from '@hcengineering/server-core'
import {
  createCollabDocInfo,
  createCollaboratorNotifications,
  removeDocInboxNotifications
} from '@hcengineering/server-notification-resources'

import { getDocUpdateAction, getTxAttributesUpdates } from './utils'

export async function OnReactionChanged (originTx: Tx, control: TriggerControl): Promise<Tx[]> {
  const tx = originTx as TxCollectionCUD<ActivityMessage, Reaction>
  const innerTx = TxProcessor.extractTx(tx) as TxCUD<Reaction>

  if (innerTx._class === core.class.TxCreateDoc) {
    return await createReactionNotifications(tx, control)
  }

  if (innerTx._class === core.class.TxRemoveDoc) {
    return await removeReactionNotifications(tx, control)
  }

  return []
}

export async function removeReactionNotifications (
  tx: TxCollectionCUD<ActivityMessage, Reaction>,
  control: TriggerControl
): Promise<Tx[]> {
  const message = (
    await control.findAll(activity.class.ActivityMessage, { objectId: tx.tx.objectId }, { projection: { _id: 1 } })
  )[0]

  if (message === undefined) {
    return []
  }

  return await removeDocInboxNotifications(message._id, control)
}

export async function createReactionNotifications (
  tx: TxCollectionCUD<ActivityMessage, Reaction>,
  control: TriggerControl
): Promise<Tx[]> {
  const createTx = TxProcessor.extractTx(tx) as TxCreateDoc<Reaction>

  const parentMessage = (await control.findAll(activity.class.ActivityMessage, { _id: tx.objectId }))[0]

  if (parentMessage === undefined) {
    return []
  }

  const user = parentMessage.createdBy

  if (user === undefined || user === core.account.System || user === tx.modifiedBy) {
    return []
  }

  let res: Tx[] = []

  const rawMessage: Data<DocUpdateMessage> = {
    txId: tx._id,
    attachedTo: parentMessage._id,
    attachedToClass: parentMessage._class,
    objectId: createTx.objectId,
    objectClass: createTx.objectClass,
    action: 'create',
    collection: 'docUpdateMessages',
    updateCollection: tx.collection
  }

  const messageTx = getDocUpdateMessageTx(control, tx, parentMessage, rawMessage, tx.modifiedBy)

  if (messageTx === undefined) {
    return []
  }

  res.push(messageTx)

  const docUpdateMessage = TxProcessor.createDoc2Doc(messageTx.tx as TxCreateDoc<DocUpdateMessage>)

  res = res.concat(
    await createCollabDocInfo([user], control, tx.tx, tx, parentMessage, [docUpdateMessage], true, false, false)
  )

  return res
}

function getDocUpdateMessageTx (
  control: ActivityControl,
  originTx: TxCUD<Doc>,
  object: Doc,
  rawMessage: Data<DocUpdateMessage>,
  modifiedBy?: Ref<Account>
): TxCollectionCUD<Doc, DocUpdateMessage> {
  const innerTx = control.txFactory.createTxCreateDoc(
    activity.class.DocUpdateMessage,
    object.space,
    rawMessage,
    undefined,
    originTx.modifiedOn,
    modifiedBy ?? originTx.modifiedBy
  )

  return control.txFactory.createTxCollectionCUD(
    rawMessage.attachedToClass,
    rawMessage.attachedTo,
    object.space,
    rawMessage.collection,
    innerTx,
    originTx.modifiedOn,
    modifiedBy ?? originTx.modifiedBy
  )
}

async function pushDocUpdateMessages (
  ctx: MeasureContext,
  control: ActivityControl,
  res: TxCollectionCUD<Doc, DocUpdateMessage>[],
  object: Doc | undefined,
  originTx: TxCUD<Doc>,
  modifiedBy?: Ref<Account>,
  objectCache?: DocObjectCache
): Promise<TxCollectionCUD<Doc, DocUpdateMessage>[]> {
  if (object === undefined) {
    return res
  }
  const activityDoc = await control.modelDb.findOne(activity.mixin.ActivityDoc, { _id: object._class })

  if (activityDoc === undefined) {
    return res
  }

  const tx =
    originTx._class === core.class.TxCollectionCUD ? (originTx as TxCollectionCUD<Doc, AttachedDoc>).tx : originTx

  const rawMessage: Data<DocUpdateMessage> = {
    txId: originTx._id,
    attachedTo: object._id,
    attachedToClass: object._class,
    objectId: tx.objectId,
    objectClass: tx.objectClass,
    action: getDocUpdateAction(control, tx),
    collection: 'docUpdateMessages',
    updateCollection:
      originTx._class === core.class.TxCollectionCUD
        ? (originTx as TxCollectionCUD<Doc, AttachedDoc>).collection
        : undefined
  }

  const attributesUpdates = await getTxAttributesUpdates(control, originTx, tx, object, objectCache)

  for (const attributeUpdates of attributesUpdates) {
    res.push(
      getDocUpdateMessageTx(
        control,
        originTx,
        object,
        {
          ...rawMessage,
          attributeUpdates
        },
        modifiedBy
      )
    )
  }

  if (attributesUpdates.length === 0 && rawMessage.action !== 'update') {
    res.push(getDocUpdateMessageTx(control, originTx, object, rawMessage, modifiedBy))
  }

  return res
}

export async function generateDocUpdateMessages (
  ctx: MeasureContext,
  tx: TxCUD<Doc>,
  control: ActivityControl,
  res: TxCollectionCUD<Doc, DocUpdateMessage>[] = [],
  originTx?: TxCUD<Doc>,
  objectCache?: DocObjectCache
): Promise<TxCollectionCUD<Doc, DocUpdateMessage>[]> {
  const { hierarchy } = control

  if (tx.space === core.space.DerivedTx) {
    return res
  }

  const etx = TxProcessor.extractTx(tx) as TxCUD<Doc>

  if (
    hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage) ||
    hierarchy.isDerived(etx.objectClass, activity.class.ActivityMessage)
  ) {
    return res
  }

  if (
    hierarchy.classHierarchyMixin(tx.objectClass, activity.mixin.IgnoreActivity) !== undefined ||
    hierarchy.classHierarchyMixin(etx.objectClass, activity.mixin.IgnoreActivity) !== undefined
  ) {
    return res
  }

  // Check if we have override control over transaction => activity mappings
  const controlRules = control.modelDb.findAllSync(activity.class.ActivityMessageControl, {
    objectClass: { $in: hierarchy.getAncestors(tx.objectClass) }
  })
  if (controlRules.length > 0) {
    for (const r of controlRules) {
      for (const s of r.skip) {
        const otx = originTx ?? etx
        if (matchQuery(otx !== undefined ? [tx, otx] : [tx], s, r.objectClass, hierarchy).length > 0) {
          // Match found, we need to skip
          return res
        }
      }
    }
  }

  switch (tx._class) {
    case core.class.TxCreateDoc: {
      const doc = TxProcessor.createDoc2Doc(tx as TxCreateDoc<Doc>)
      return await ctx.with(
        'pushDocUpdateMessages',
        {},
        async (ctx) => await pushDocUpdateMessages(ctx, control, res, doc, originTx ?? tx, undefined, objectCache)
      )
    }
    case core.class.TxMixin:
    case core.class.TxUpdateDoc: {
      let doc = objectCache?.docs?.get(tx.objectId)
      if (doc === undefined) {
        doc = (await control.findAll(tx.objectClass, { _id: tx.objectId }, { limit: 1 }))[0]
      }
      return await ctx.with(
        'pushDocUpdateMessages',
        {},
        async (ctx) =>
          await pushDocUpdateMessages(ctx, control, res, doc ?? undefined, originTx ?? tx, undefined, objectCache)
      )
    }
    case core.class.TxCollectionCUD: {
      const actualTx = TxProcessor.extractTx(tx) as TxCUD<Doc>
      res = await generateDocUpdateMessages(ctx, actualTx, control, res, tx, objectCache)
      if ([core.class.TxCreateDoc, core.class.TxRemoveDoc, core.class.TxUpdateDoc].includes(actualTx._class)) {
        let doc = objectCache?.docs?.get(tx.objectId)
        if (doc === undefined) {
          doc = (await control.findAll(tx.objectClass, { _id: tx.objectId }, { limit: 1 }))[0]
        }
        if (doc !== undefined) {
          return await ctx.with(
            'pushDocUpdateMessages',
            {},
            async (ctx) =>
              await pushDocUpdateMessages(ctx, control, res, doc ?? undefined, originTx ?? tx, undefined, objectCache)
          )
        }
      }
      return res
    }
  }

  return res
}

async function ActivityMessagesHandler (tx: TxCUD<Doc>, control: TriggerControl): Promise<Tx[]> {
  if (control.hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
    return []
  }

  const txes = await control.ctx.with(
    'generateDocUpdateMessages',
    {},
    async (ctx) => await generateDocUpdateMessages(ctx, tx, control)
  )
  const messages = txes.map((messageTx) => TxProcessor.createDoc2Doc(messageTx.tx as TxCreateDoc<DocUpdateMessage>))

  const notificationTxes = await control.ctx.with(
    'createNotificationTxes',
    {},
    async (ctx) => await createCollaboratorNotifications(ctx, tx, control, messages)
  )

  return [...txes, ...notificationTxes]
}

async function OnDocRemoved (originTx: TxCUD<Doc>, control: TriggerControl): Promise<Tx[]> {
  const tx = TxProcessor.extractTx(originTx) as TxCUD<Doc>

  if (tx._class !== core.class.TxRemoveDoc) {
    return []
  }

  const activityDocMixin = control.hierarchy.classHierarchyMixin(tx.objectClass, activity.mixin.ActivityDoc)

  if (activityDocMixin === undefined) {
    return []
  }

  const messages = await control.findAll(
    activity.class.ActivityMessage,
    { attachedTo: tx.objectId },
    { projection: { _id: 1, _class: 1, space: 1 } }
  )

  return messages.map((message) => control.txFactory.createTxRemoveDoc(message._class, message.space, message._id))
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    ActivityMessagesHandler,
    OnDocRemoved,
    OnReactionChanged
  }
})
