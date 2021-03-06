import Promise from 'bluebird';
import map from 'lodash/map';
import differenceBy from 'lodash/differenceBy';
import moment from 'moment';

import Comment from '../models/comment.model';
import User from '../models/user.model';
import ForumThread from '../models/forumThread.model';
import MailNotification from '../helpers/mailNotification.helper';
import { subscribePostFromEntity, notifyPostSubscribersFromEntity } from '../controllers/postSubscription.controller';
import { subscribeTopicPage, notifySubscribers } from '../controllers/topicPageSubscription.controller';
import { saveAndNotifyUser } from '../controllers/notification.controller';
/*
* Load comment and append to req.
*/
function load(req, res, next, id) {
  Comment.get(id)
    .then((comment) => {
      req.comment = comment; // eslint-disable-line no-param-reassign
      return next();
    })
    .catch(e => next(e));
}

/**
 * @swagger
 * /comments/{commentId}:
 *   delete:
 *     summary: Delete a comment
 *     description: Mark a comment as deleted
 *     tags: [comment]
 *     security:
 *       - Token: []
 *     parameters:
 *       - in: path
 *         name: commentId
 *         schema:
 *            type: String
 *         required: true
 *         description: Id of the comment to be deleted
 *     responses:
 *       '200':
 *         description: successful operation
 *         schema:
 *            type: object
 *            properties:
 *              deleted:
 *                type: string
 *                enum: 'true'
 *       '401':
 *         $ref: '#/responses/Unauthorized'
 *       '404':
 *         $ref: '#/responses/NotFound'
 */
function remove(req, res, next) {
  const { comment, user } = req;

  if (comment && user) {
    if (comment.author._id.toString() !== user._id.toString()) {
      return res.status(401).json({ Error: 'Please login' });
    }

    comment.deleted = true;
    comment.dateDeleted = moment().format('LLL');
    return comment
      .save()
      .then(() => {
        // Sucess:
        res.json({ deleted: true });
      })
      .then(() => {
        ForumThread.increaseCommentCount(comment.rootEntity, -1);
      })
      .catch((e) => {
        next(e);
      });
  }

  return res.status(500).json({});
}

async function idsToUsers(ids) {
  const users = [];
  // TODO: dont block on each mention:
  // https://eslint.org/docs/rules/no-await-in-loop
  /* eslint-disable no-await-in-loop */
  for (let ii = 0; ii < ids.length; ii += 1) {
    try {
      const id = ids[ii];
      const user = await User.get(id);
      users.push(user);
    } catch (e) {
      console.log('e.idsToUsers', e); // eslint-disable-line
    }
  }
  /* eslint-disable no-await-in-loop */
  return users;
}

function extractedNewMentions(comment, updatedMentions) {
  const oldMentions = comment.mentions;
  if (!oldMentions) return updatedMentions;
  function getUserId(user) {
    return user._id.toString();
  }
  const newlyAddedMentions = differenceBy(
    updatedMentions,
    oldMentions,
    getUserId
  );
  return newlyAddedMentions;
}

async function update(req, res, next) {
  const { comment, user } = req;
  const { content, mentions, highlight } = req.body;

  if (comment && user) {
    if (comment.author._id.toString() !== user._id.toString()) {
      return res.status(401).json({ Error: 'Please login' });
    }

    if (highlight) {
      comment.highlight = highlight;
    }

    comment.content = content;
    comment.dateLastEdited = Date();

    if (mentions) {
      try {
        const updatedMentions = await idsToUsers(mentions);
        const newMentions = extractedNewMentions(comment, updatedMentions);
        comment.mentions = updatedMentions;
        const { rootEntity: entityId, entityType } = comment;
        MailNotification.handleUpdatedComment(entityId, entityType, user, comment, newMentions);
      } catch (e) {
        console.log('e', e); // eslint-disable-line
      }
    } else {
      comment.mentions = [];
    }

    return comment
      .save()
      .then((editedComment) => {
        // Sucess:
        res.json(editedComment);
      })
      .catch((e) => {
        next(e);
      });
  }
  return res.status(500).json({});
}

/**
 * @swagger
 * tags:
 * - name: comment
 *   description: Commenting of Episodes
 */

/**
 * @swagger
 * /posts/{postId}/comment:
 *   post:
 *     summary: Create comment for episode
 *     description: Create comment for episode
 *     tags: [comment]
 *     security:
 *       - Token: []
 *     parameters:
 *       - $ref: '#/parameters/postId'
 *       - in: body
 *         name: content
 *         type: string
 *         required: true
 *         description: Comment content
 *     responses:
 *       '201':
 *         description: successful created
 *         schema:
 *           type: object
 *           properties:
 *             result:
 *               $ref: '#/definitions/Comment'
 *       '401':
 *         $ref: '#/responses/Unauthorized'
 *       '404':
 *         $ref: '#/responses/NotFound'
 */

async function subscribeAndNotifyCommenter(entityId, entityType, user, ignoreNotify) {
  const payload = {
    notification: {
      title: `New comment from @${user.name}`,
    },
    type: 'comment',
  };

  if (entityType.toLowerCase() === 'forumthread') {
    const post = await subscribePostFromEntity(entityId, user);
    payload.notification.body = post.title.rendered;
    payload.notification.data = {
      user: user.username,
      slug: post.slug,
      url: `/post/${post._id}/${post.slug}`,
      thread: post.thread
    };
    payload.entity = post._id;
    // notify all subscribers
    await notifyPostSubscribersFromEntity(entityId, user, payload, ignoreNotify);
  }

  if (entityType.toLowerCase() === 'topic') {
    const topic = await subscribeTopicPage(entityId, user);
    payload.notification.body = topic.name;
    payload.notification.data = {
      user: user.username,
      slug: topic.slug,
      url: `/topic/${topic.slug}`
    };
    payload.entity = entityId;
    // notify all subscribers
    await notifySubscribers(entityId, user, payload, ignoreNotify);
  }
}

async function subscribeAndNotifyMentioned(entityId, entityType, mentioned, user) {
  if (entityType.toLowerCase() === 'forumthread') {
    const post = await subscribePostFromEntity(entityId, mentioned);

    const payload = {
      notification: {
        title: `You were mentioned by @${user.name}`,
        body: post.title.rendered,
        data: {
          user: user.username,
          mentioned: mentioned._id,
          slug: post.slug,
          url: `/post/${post._id}/${post.slug}`,
          thread: post.thread
        }
      },
      type: 'mention',
      entity: post._id
    };

    // just notify the mentioned user
    saveAndNotifyUser(payload, mentioned._id);
  }
  if (entityType.toLowerCase() === 'topic') {
    const topic = await subscribeTopicPage(entityId, mentioned);
    const payload = {
      notification: {
        title: `You were mentioned by @${user.name}`,
        body: topic.name,
        data: {
          user: user.username,
          mentioned: mentioned._id,
          url: `/topic/${topic.slug}`,
          slug: topic.slug
        }
      },
      type: 'mention',
      entity: entityId
    };

    // just notify the mentioned user
    saveAndNotifyUser(payload, mentioned._id);
  }
}

async function create(req, res, next) {
  const { entityId } = req.params;
  const { parentCommentId, mentions } = req.body;
  const { content, entityType, highlight } = req.body;
  const { user } = req;

  const comment = new Comment();
  comment.content = content || '';

  if (!highlight && !content) {
    return res.status(500).json({ Error: 'Property `content` is required when not a highlight' });
  }

  let usersMentioned = [];
  if (mentions) {
    usersMentioned = await idsToUsers(mentions);
    comment.mentions = usersMentioned;
    usersMentioned.forEach((mentioned) => {
      subscribeAndNotifyMentioned(entityId, entityType, mentioned, user);
    });
  }

  if (highlight) {
    comment.highlight = highlight;
  }

  comment.rootEntity = entityId;
  comment.entityType = entityType;
  // If this is a child comment we need to assign it's parent
  if (parentCommentId) {
    comment.parentComment = parentCommentId;
  }
  comment.author = user._id;

  return comment
    .save()
    .then(async (commentSaved) => {
      subscribeAndNotifyCommenter(entityId, entityType, user, mentions); // don't await

      MailNotification.handleNotification(entityId, entityType, user, comment);

      if (entityType && entityType.toLowerCase() === 'forumthread') {
        ForumThread.increaseCommentCount(entityId);
      }

      return res.status(201).json({ result: commentSaved });
    })
    .catch(err => next(err));
}

/**
 * @swagger
 * /posts/{postId}/comments:
 *   get:
 *     summary: Get comments for episode
 *     description: Get comments for episode
 *     tags: [comment]
 *     security: []
 *     parameters:
 *       - $ref: '#/parameters/postId'
 *     responses:
 *       '200':
 *         description: successful operation
 *         schema:
 *           type: object
 *           properties:
 *             result:
 *               type: array
 *               items:
 *                 $ref: '#/definitions/Comment'
 *       '404':
 *         $ref: '#/responses/NotFound'
 */
function list(req, res, next) {
  const { entityId } = req.params;
  // TODO loop through and replace comments that are deleted with "This comment has been deleted"
  Comment.getTopLevelCommentsForItem(entityId)
    .then((comments) => {
      // Here we are fetching our nested comments, and need everything to finish
      const nestedCommentPromises = map(comments, comment => Comment.fillNestedComments(comment));
      return Promise.all(nestedCommentPromises);
    })
    .then((comments) => {
      const updatedComments = Comment.upadteDeletedCommentContent(comments);
      return updatedComments;
    })
    .then((parentComments) => {
      // If authed then fill in if user has liked:
      if (req.user) {
        // Let's get all our vote info for both children and parent comments:
        return Comment.populateVoteInfo(parentComments, req.user);
      }
      return parentComments;
    })
    .then((parentComments) => {
      res.json({ result: parentComments });
    })
    .catch(e => next(e));
}

export default {
  load,
  list,
  create,
  remove,
  update
};
