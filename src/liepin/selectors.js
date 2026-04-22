export const recommendSelectors = {
  card: '[class*="newResumeItemWrap"]',
  segmentedLabel: ".ant-lpt-segmented-item-label",
  modalRoot: '[class*="resume-detail-modal-wrap"]',
  modalPrintable: '[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content',
  nextButton: ".button-turn-next",
  closeButton: '[class*="resume-detail-modal-wrap"] [class*="closeBtn"]',
  openChatButton: '[class*="resume-detail-modal-wrap"] [class*="xpath-open-im-btn"]'
};

export const chatSelectors = {
  conversationRow: ".im-ui-contact-list-item.im-ui-contact-item",
  resumeActionButton: ".im-ui-action-button.action-item.action-resume",
  genericActionButton: ".im-ui-action-button.action-item",
  specialBrowseButton: "button, a, span, div",
  chatContainer: ".im-ui-chat-container",
  chatContentWrapper: ".im-ui-chat-content-wrapper",
  chatHeader: ".im-ui-pro-chat-header",
  chatHeaderBasicInfo: ".im-ui-pro-chat-header-basic-info-content",
  chatHeaderUserInfo: ".im-ui-pro-chat-header-user-info",
  chatHeaderResumeContent: ".im-ui-pro-chat-header-resume-content",
  chatHeaderExtInfo: ".im-ui-pro-chat-header-ext-info",
  chatHeaderExtContent: ".im-ui-pro-chat-header-ext-content",
  messageList: ".im-ui-message-list-wrapper.im-ui-chat-list, .im-ui-msg-list-content",
  actionBar: ".chatwin-action, .im-ui-chat-input, .actions-left"
};

export const resumeDetailSelectors = {
  printable: ".printable-content",
  pageWrap: '[class*="resume-detail-page-wrap"].printable-content, .resume-detail-page-wrap.printable-content',
  individualInfo: '[class*="individualInfo"]',
  sectionHeader: '[class*="header"]',
  openImButton: '[class*="xpath-open-im-btn"]',
  portfolioWrap: '[class*="xpath-portfolio-wrap"]'
};
